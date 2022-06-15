import {AirbyteRecord} from 'faros-airbyte-cdk';
import {Utils} from 'faros-feeds-sdk';

import {DestinationModel, DestinationRecord, StreamContext} from '../converter';
import {GitHubCommon, GitHubConverter} from './common';

export class ReviewComments extends GitHubConverter {
  readonly destinationModels: ReadonlyArray<DestinationModel> = [
    'vcs_PullRequestCommit',
  ];

  async convert(
    record: AirbyteRecord,
    ctx: StreamContext
  ): Promise<ReadonlyArray<DestinationRecord>> {
    const source = this.streamName.source;
    const commit = record.record.data;

    const repository = GitHubCommon.parseRepositoryKey(
      commit.repository,
      source
    );

    if (!repository) return [];

    // Parse the PR number from the pull request url
    const prNum = GitHubCommon.parsePRnumber(commit.pull_request_url);
    return [
      {
        model: 'vcs_PullRequestCommit',
        record: {
          commit: {
            sha: commit.sha,
            repository,
          },
          pullRequest: {
            number: prNum,
            repository,
          },
        },
      },
    ];
  }
}
