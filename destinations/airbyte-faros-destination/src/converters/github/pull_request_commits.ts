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
    return [
      {
        model: 'vcs_PullRequestCommit',
        record: {
          commit: {
            sha: commit.sha,
            repository,
          },
          pullRequest: {
            number: commit.pull_number,
            repository,
          },
        },
      },
    ];
  }
}
