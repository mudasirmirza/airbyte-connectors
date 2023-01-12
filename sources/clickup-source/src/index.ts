import {Command} from 'commander';
import {
  AirbyteConfig,
  AirbyteLogger,
  AirbyteSourceBase,
  AirbyteSourceRunner,
  AirbyteSpec,
  AirbyteStreamBase,
} from 'faros-airbyte-cdk';
import VError from 'verror';

import {ClickUp} from './clickup';
import {Folders} from './streams/folders';
import {Goals} from './streams/goals';
import {Lists} from './streams/lists';
import {Spaces} from './streams/spaces';
import {Tasks} from './streams/tasks';
import {Workspaces} from './streams/workspaces';

export interface ClickUpConfig extends AirbyteConfig {
  token: string;
  fetch_archived?: boolean;
  cutoff_days?: number;
  timeout?: number;
  max_content_length?: number;
  max_retries?: number;
}

/** The main entry point. */
export function mainCommand(): Command {
  const logger = new AirbyteLogger();
  const source = new ClickUpSource(logger);
  return new AirbyteSourceRunner(logger, source).mainCommand();
}

export class ClickUpSource extends AirbyteSourceBase<ClickUpConfig> {
  async spec(): Promise<AirbyteSpec> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return new AirbyteSpec(require('../resources/spec.json'));
  }

  async checkConnection(config: ClickUpConfig): Promise<[boolean, VError]> {
    try {
      const clickup = ClickUp.make(config, this.logger);
      await clickup.checkConnection();
    } catch (error: any) {
      return [false, error];
    }
    return [true, undefined];
  }

  streams(config: ClickUpConfig): AirbyteStreamBase[] {
    return [Folders, Goals, Lists, Spaces, Tasks, Workspaces].map(
      (Stream) => new Stream(config, this.logger)
    );
  }
}