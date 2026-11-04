// SPDX-License-Identifier: Apache-2.0
// Minimal string table for the M0 shell. The ICU catalog shared with web arrives with M1b.
export const strings = {
  appName: 'our-stream',
  tagline: 'Knowledge streams for teams: short clips, the right audience, answers you can trust.',
  statusHeading: 'Status',
  loading: 'Checking the API…',
  apiReachable: (version: string) => `API version ${version} is reachable.`,
  apiUnreachable: 'The API is not reachable yet.',
  sourceLink: 'Source code (Apache-2.0 app, AGPL-3.0 platform)',
};
