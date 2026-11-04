# Third-party notices for apps/mobile

The our-stream mobile application is licensed under Apache-2.0 (see LICENSE). It depends on the
following third-party packages, all under permissive licenses compatible with Apache-2.0; their
license texts ship with the packages in `node_modules` and in the app bundle's license report.

| Package                                                                                                                                                                       | License                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| expo, expo-router, expo-video, expo-secure-store, expo-crypto, expo-linking, expo-constants, expo-font, expo-splash-screen, expo-status-bar, expo-system-ui, expo-web-browser | MIT                                                |
| react, react-dom, react-native, react-native-web                                                                                                                              | MIT                                                |
| react-native-gesture-handler, react-native-reanimated, react-native-worklets, react-native-safe-area-context, react-native-screens                                            | MIT                                                |
| @react-native-async-storage/async-storage                                                                                                                                     | MIT                                                |
| zod, openapi-fetch (via @our-stream/contracts)                                                                                                                                | MIT                                                |
| @our-stream/contracts (this repository)                                                                                                                                       | AGPL-3.0-only OR Apache-2.0, used under Apache-2.0 |

Development-only tooling (typescript, vitest, @types/react) is not distributed with the app.

The initial project structure was generated with create-expo-app (template default@sdk-58), which is
distributed under the MIT License reproduced below.

```
The MIT License (MIT)

Copyright (c) 2015-present 650 Industries, Inc. (aka Expo)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
