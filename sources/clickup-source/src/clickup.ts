import axios, {AxiosInstance, AxiosRequestConfig, AxiosResponse} from 'axios';
import axiosRetry, {
  IAxiosRetryConfig,
  isIdempotentRequestError,
} from 'axios-retry';
import {AirbyteLogger, wrapApiError} from 'faros-airbyte-cdk';
import {
  Folder,
  Goal,
  List,
  Space,
  Task,
  Workspace,
} from 'faros-airbyte-common/clickup';
import isRetryAllowed from 'is-retry-allowed';
import {Dictionary} from 'ts-essentials';
import {Memoize} from 'typescript-memoize';
import {VError} from 'verror';

import {ClickUpConfig} from '.';

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_MAX_CONTENT_LENGTH = 10_000_000;
const DEFAULT_MAX_RETRIES = 3;
const BASE_API_URL = 'https://api.clickup.com/api/v2';

export class ClickUp {
  private static instance: ClickUp = undefined;

  constructor(
    private readonly logger: AirbyteLogger,
    private readonly api: AxiosInstance,
    private readonly defaultStartDate: Date,
    private readonly maxRetries: number
  ) {}

  static make(cfg: ClickUpConfig, logger: AirbyteLogger): ClickUp {
    if (ClickUp.instance) return ClickUp.instance;

    if (!cfg.token) {
      throw new VError('api_token must not be an empty string');
    }
    if (!Number.isInteger(cfg.cutoff_days) || cfg.cutoff_days < 1) {
      throw new VError('cutoff_days must be a positive number');
    }
    if (cfg.timeout < 1) {
      throw new VError('timeout must be a positive number');
    }
    const api = axios.create({
      baseURL: BASE_API_URL,
      timeout: cfg.timeout ?? DEFAULT_TIMEOUT,
      maxContentLength: cfg.max_content_length ?? DEFAULT_MAX_CONTENT_LENGTH,
      headers: {
        authorization: cfg.token,
        'content-type': 'application/json',
      },
    });

    // TODO: refactor to common library and apply to all sources that use axios
    const isNetworkError = (error): boolean => {
      return (
        !error.response &&
        Boolean(error.code) && // Prevents retrying cancelled requests
        isRetryAllowed(error) // Prevents retrying unsafe errors
      );
    };
    const retryCondition = (error: Error): boolean => {
      return isNetworkError(error) || isIdempotentRequestError(error);
    };
    const maxRetries = cfg.max_retries ?? DEFAULT_MAX_RETRIES;
    const retryConfig: IAxiosRetryConfig = {
      retryDelay: axiosRetry.exponentialDelay,
      shouldResetTimeout: true,
      retries: maxRetries,
      retryCondition,
      onRetry(retryCount, error, requestConfig) {
        logger.info(
          `Retrying request ${requestConfig.url} due to an error: ${error.message} ` +
            `(attempt ${retryCount} of ${maxRetries})`
        );
      },
    };
    axiosRetry(api, retryConfig);

    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - cfg.cutoff_days);

    ClickUp.instance = new ClickUp(logger, api, defaultStartDate, maxRetries);
    return ClickUp.instance;
  }

  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private async maybeSleepOnResponse<T = any>(
    path: string,
    res?: AxiosResponse<T>
  ): Promise<boolean> {
    const retryAfterSecs = res?.headers?.['retry-after'];
    if (retryAfterSecs) {
      const retryRemaining = res?.headers?.['x-ratelimit-remaining'];
      const retryRatelimit = res?.headers?.['x-ratelimit-limit'];
      this.logger.warn(
        `'Retry-After' response header is detected when requesting ${path}. ` +
          `Waiting for ${retryAfterSecs} seconds before making any requests. ` +
          `(TSTUs remaining: ${retryRemaining}, TSTUs total limit: ${retryRatelimit})`
      );
      await this.sleep(Number.parseInt(retryAfterSecs) * 1000);
      return true;
    }
    return false;
  }

  private async getHandleNotFound<T = any, D = any>(
    path: string,
    conf?: AxiosRequestConfig<D>,
    attempt = 1
  ): Promise<AxiosResponse<T> | undefined> {
    try {
      const res = await this.api.get<T, AxiosResponse<T>>(path, conf);
      await this.maybeSleepOnResponse(path, res);
      return res;
    } catch (err: any) {
      if (err?.response?.status === 429 && attempt <= this.maxRetries) {
        this.logger.warn(
          `Request to ${path} was rate limited. Retrying... ` +
            `(attempt ${attempt} of ${this.maxRetries})`
        );
        await this.maybeSleepOnResponse(path, err?.response);
        return await this.getHandleNotFound(path, conf, attempt + 1);
      }
      if (err?.response?.status === 404) {
        return undefined;
      }
      throw wrapApiError(err, `Failed to get ${path}. `);
    }
  }

  private get<T = any>(
    path: string,
    params: Dictionary<any> = {}
  ): Promise<AxiosResponse<T> | undefined> {
    return this.getHandleNotFound(path, {params});
  }

  async checkConnection(): Promise<void> {
    const workspaces = await this.workspaces();
    if (workspaces.length <= 0) {
      throw new VError('No workspaces were found');
    }
  }

  @Memoize()
  async workspaces(): Promise<ReadonlyArray<Workspace>> {
    try {
      return (await this.get('/team')).data.teams;
    } catch (err) {
      throw new VError(wrapApiError(err as any), 'Failed to fetch workspaces');
    }
  }

  private async fetchData<T>(
    fetch: (archived: boolean) => Promise<ReadonlyArray<T>>,
    fetchArchived: boolean,
    errorMsg: string,
    ...errorMsgParams: ReadonlyArray<any>
  ): Promise<ReadonlyArray<T>> {
    try {
      const results = [];
      results.push(...(await fetch(false)));
      if (fetchArchived) {
        results.push(...(await fetch(true)));
      }
      return results;
    } catch (err) {
      throw new VError(wrapApiError(err as any), errorMsg, ...errorMsgParams);
    }
  }

  @Memoize(
    (workspaceId: string, fetchArchived: boolean) =>
      `${workspaceId};${fetchArchived}`
  )
  async spaces(
    workspaceId: string,
    fetchArchived = false
  ): Promise<ReadonlyArray<Space>> {
    return await this.fetchData(
      async (archived) => {
        return (await this.get(`/team/${workspaceId}/space`, {archived})).data
          .spaces;
      },
      fetchArchived,
      'Failed to fetch spaces for workspace id %s',
      workspaceId
    );
  }

  @Memoize(
    (spaceId: string, fetchArchived: boolean) => `${spaceId};${fetchArchived}`
  )
  async folders(
    spaceId: string,
    fetchArchived = false
  ): Promise<ReadonlyArray<Folder>> {
    return await this.fetchData(
      async (archived) => {
        return (await this.get(`/space/${spaceId}/folder`, {archived})).data
          .folders;
      },
      fetchArchived,
      'Failed to fetch folders for space id %s',
      spaceId
    );
  }

  @Memoize(
    (folderId: string, fetchArchived: boolean) => `${folderId};${fetchArchived}`
  )
  async listsInFolder(
    folderId: string,
    fetchArchived = false
  ): Promise<ReadonlyArray<List>> {
    return await this.fetchData(
      async (archived) => {
        return (await this.get(`/folder/${folderId}/list`, {archived})).data
          .lists;
      },
      fetchArchived,
      'Failed to fetch lists for folder id %s',
      folderId
    );
  }

  @Memoize(
    (spaceId: string, fetchArchived: boolean) => `${spaceId};${fetchArchived}`
  )
  async listsInSpace(
    spaceId: string,
    fetchArchived = false
  ): Promise<ReadonlyArray<List>> {
    return await this.fetchData(
      async (archived) => {
        return (await this.get(`/space/${spaceId}/list`, {archived})).data
          .lists;
      },
      fetchArchived,
      'Failed to fetch lists for space id %s',
      spaceId
    );
  }

  private async *fetchTasks(
    listId: string,
    archived: boolean,
    lastUpdatedDate?: number
  ): AsyncGenerator<Task> {
    let page = 0;
    let morePages = true;
    while (morePages) {
      const tasks: Task[] = (
        await this.get(`/list/${listId}/task`, {
          archived,
          page,
          date_updated_gt: lastUpdatedDate ?? this.defaultStartDate.getTime(),
          include_closed: true,
          order_by: 'updated',
          subtasks: true,
        })
      ).data.tasks;
      for (const task of tasks) {
        yield task;
      }
      page++;
      morePages = tasks.length > 0;
    }
  }

  async *tasks(
    listId: string,
    lastUpdatedDate?: number,
    fetchArchived = false
  ): AsyncGenerator<Task> {
    try {
      for await (const t of this.fetchTasks(listId, false, lastUpdatedDate)) {
        yield t;
      }
      if (fetchArchived) {
        for await (const t of this.fetchTasks(listId, true, lastUpdatedDate)) {
          yield t;
        }
      }
    } catch (err) {
      throw new VError(
        wrapApiError(err as any),
        'Failed to fetch tasks for list id',
        listId
      );
    }
  }

  async *goals(workspaceId: string): AsyncGenerator<Goal> {
    try {
      const goals = (
        await this.get(`/team/${workspaceId}/goal`, {include_completed: true})
      ).data.goals;
      for (const goal of goals) {
        yield (await this.get(`/goal/${goal.id}`)).data.goal;
      }
    } catch (err) {
      throw new VError(
        wrapApiError(err as any),
        'Failed to fetch goals for workspace id',
        workspaceId
      );
    }
  }
}
