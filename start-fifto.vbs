Set WshShell = CreateObject("WScript.Shell")
' 1 = normal window, 7 = minimized — change to 7 to start minimized
WshShell.Run "cmd /k """ & "E:\Projects\TradeSecret Nifty Option selling\start-fifto.bat" & """", 7, False
