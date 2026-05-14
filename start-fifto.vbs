Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & ScriptDir & "\start-fifto.ps1""", 0, False
