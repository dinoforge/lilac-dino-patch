// The app uses JASSUB's local system font lookup and subtitle-bundled fonts only.
// Keep the optional remote-font branch inert even if a future caller enables it.
export async function queryRemoteFonts() {
  return [];
}
