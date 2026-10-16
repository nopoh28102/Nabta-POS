Option Explicit
Dim shell, fso, root, app, file
Set shell = CreateObject("Shell.Application")
Set fso = CreateObject("Scripting.FileSystemObject")
root = shell.Namespace(&H26).Self.Path & "\@nabtadesktop"
If Not fso.FolderExists(root) Then
  root = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "win-unpacked")
  If Not fso.FolderExists(root) Then root = fso.GetParentFolderName(WScript.ScriptFullName)
End If
app = ""
If fso.FolderExists(root) Then
  For Each file In fso.GetFolder(root).Files
    If LCase(fso.GetExtensionName(file.Name)) = "exe" Then
      ' The installed product name may be Arabic, while the uninstaller is also an .exe.
      ' Select the large Electron executable and never the small uninstaller/setup file.
      If file.Size > 10000000 Then
        If InStr(LCase(file.Name), "uninstall") = 0 And InStr(LCase(file.Name), "setup") = 0 And InStr(LCase(file.Name), "remove") = 0 Then
          If app = "" Then app = file.Path
        End If
      End If
    End If
  Next
End If
If app = "" Then
  root = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "win-unpacked")
  If Not fso.FolderExists(root) Then root = fso.GetParentFolderName(WScript.ScriptFullName)
  If fso.FolderExists(root) Then
    For Each file In fso.GetFolder(root).Files
      If LCase(fso.GetExtensionName(file.Name)) = "exe" And file.Size > 10000000 Then
        If InStr(LCase(file.Name), "uninstall") = 0 And InStr(LCase(file.Name), "setup") = 0 And InStr(LCase(file.Name), "remove") = 0 Then
          app = file.Path
          Exit For
        End If
      End If
    Next
  End If
End If
If app = "" Then
  MsgBox "Nabta executable was not found. Install Nabta first.", 48, "Nabta"
  WScript.Quit 1
End If
shell.ShellExecute app, "--run-server", "", "runas", 0
