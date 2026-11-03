import Foundation
import Darwin

// Нативный launcher подписывается как Mach-O; runtime и CLI находятся только внутри .app.
let directory = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent()
let runtime = directory.appendingPathComponent("bun")
let script = directory.deletingLastPathComponent().appendingPathComponent("Resources/cli/litellm-spend.js")
if chdir(script.deletingLastPathComponent().path) != 0 {
    perror("Could not open bundled CLI directory")
    exit(1)
}
let arguments = ([runtime.path, script.path] + CommandLine.arguments.dropFirst()).map { strdup($0) } + [nil]
arguments.withUnsafeBufferPointer { buffer in
    _ = execv(runtime.path, buffer.baseAddress!)
}
perror("Could not start bundled CLI")
exit(1)
