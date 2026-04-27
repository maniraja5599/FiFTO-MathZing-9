Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
' 1 = normal window, 7 = minimized — change to 7 to start minimized
WshShell.Run "cmd /k """ & ScriptDir & "\start-fifto.bat" & """", 7, False
