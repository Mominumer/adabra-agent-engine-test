// Windows only, and not run by Node: wscript.exe runs this for the helper's scheduled task (old JScript, so no let,
// const or arrow functions). It exists so the agent starts with no window. wscript.exe is not a console program, so
// Windows opens no console for it, and it starts node hidden from the first moment. `powershell -WindowStyle Hidden`
// hides its window too late to stop a flash, and does not hide it at all when Windows Terminal is the default terminal.
//
//   wscript.exe //B //NoLogo //E:JScript helper-launcher.js <node.exe> <supervisor.js> <agent home> <log file>
var args = WScript.Arguments;
var node = args.Item(0);
var supervisor = args.Item(1);
var agentHome = args.Item(2);
var logFile = args.Item(3);
var fso = new ActiveXObject('Scripting.FileSystemObject');

function quote(s) {
  return '"' + s + '"';
}

if (!fso.FileExists(node) || !fso.FileExists(supervisor)) {
  var out = fso.OpenTextFile(logFile, 8, true); // 8 = append, true = create if missing
  out.WriteLine(new Date().toUTCString() + ' launcher: node or helper\\supervisor.js has moved; run service\\helper-service.ps1 install again');
  out.Close();
  WScript.Quit(2);
}

var shell = new ActiveXObject('WScript.Shell');
// 0 = hidden, true = wait: the task stays "running" for as long as the supervisor does, which is what keeps the
// repeating trigger from starting another copy.
WScript.Quit(shell.Run(quote(node) + ' ' + quote(supervisor) + ' run --home ' + quote(agentHome) + ' --log ' + quote(logFile), 0, true));
