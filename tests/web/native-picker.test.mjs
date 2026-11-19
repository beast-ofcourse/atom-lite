// Reason: the web workspace picker must use the OS-native dialog on every
// supported desktop, and map Android SAF tree URIs back to a real path.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  androidTreeUriToPath,
  folderPickerCommands,
  isAndroid,
} from "../../dist/web/native-picker.js";

test("desktop pickers use the platform's native dialog", () => {
  assert.equal(folderPickerCommands("darwin")[0].command, "osascript");
  assert.equal(folderPickerCommands("win32")[0].command, "powershell.exe");
  assert.equal(folderPickerCommands("linux")[0].command, "zenity");
  assert.equal(folderPickerCommands("linux")[1].command, "kdialog");
});

test("Termux selects the Android SAF directory picker", () => {
  const commands = folderPickerCommands("linux", { TERMUX_VERSION: "0.118" });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "termux-saf-managedir");
});

test("Android detection covers both process platform and Termux", () => {
  assert.equal(isAndroid("android", {}), true);
  assert.equal(isAndroid("linux", { TERMUX_VERSION: "0.118" }), true);
  assert.equal(isAndroid("linux", {}), false);
  assert.equal(isAndroid("darwin", {}), false);
});

test("Android SAF tree URIs map to shared-storage paths", () => {
  assert.equal(
    androidTreeUriToPath(
      "content://com.android.externalstorage.documents/tree/primary%3Aprojects%2Fatom-lite",
    ),
    "/storage/emulated/0/projects/atom-lite",
  );
  assert.equal(
    androidTreeUriToPath(
      "content://com.android.externalstorage.documents/tree/0123-4567%3Awork",
    ),
    "/storage/0123-4567/work",
  );
  assert.equal(
    androidTreeUriToPath(
      "content://com.android.providers.downloads.documents/tree/downloads",
    ),
    "/storage/emulated/0/Download",
  );
  assert.equal(
    androidTreeUriToPath(
      "content://com.android.externalstorage.documents/tree/primary%3A",
    ),
    "/storage/emulated/0",
  );
  assert.equal(
    androidTreeUriToPath("content://com.android.providers.media.documents"),
    null,
  );
});
