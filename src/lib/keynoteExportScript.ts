export function escapeAppleScriptString(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// The document-count comparison detects decks the user already has open:
// Keynote's `open` returns the existing document (count unchanged) instead of
// opening a second copy. Documents this script did not open are never closed,
// so a user's unsaved edits are preserved.
export function buildKeynoteExportScript(keynoteAppPath: string) {
  return `
on run argv
  set keynotePath to item 1 of argv
  set pdfPath to item 2 of argv
  set keynoteFile to POSIX file keynotePath
  set pdfFile to POSIX file pdfPath
  tell application "${escapeAppleScriptString(keynoteAppPath)}"
    activate
    set documentCountBeforeOpen to count of documents
    set openedDocument to open keynoteFile
    set documentWasAlreadyOpen to ((count of documents) is documentCountBeforeOpen)
    try
      with timeout of 1200 seconds
        export openedDocument to pdfFile as PDF
      end timeout
      if not documentWasAlreadyOpen then close openedDocument saving no
    on error exportError number exportErrorNumber
      if not documentWasAlreadyOpen then
        try
          close openedDocument saving no
        end try
      end if
      error exportError number exportErrorNumber
    end try
  end tell
end run
`;
}
