import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  TerminalProcess,
  terminalInfo,
  stopTerminalProcesses,
} from "../src/orchestrator/terminal.js";

const helpers: ChildProcess[] = [];
afterEach(() => {
  stopTerminalProcesses();
  for (const child of helpers.splice(0)) if (child.exitCode === null) child.kill();
});
const script = `
const net=require('node:net'),readline=require('node:readline');
const [pipe,token]=process.argv.slice(1);
const socket=net.connect(pipe,()=>socket.write(JSON.stringify({type:'hello',token,pid:process.pid})+'\\n'));
readline.createInterface({input:socket}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='start'){socket.write(JSON.stringify({type:'spawned',pid:process.pid})+'\\n');socket.write(JSON.stringify({type:'ready',firstFrameMs:12,firstFramePainted:true,minimized:true,userRestored:false,paintedRevision:3,columns:120,rows:36,conversations:1,windowHandle:m.windowHandle})+'\\n');socket.write(JSON.stringify({type:'stdout',data:Buffer.from(m.env.ANTHROPIC_MODEL).toString('base64')})+'\\n');}
 if(m.type==='stdin')socket.write(JSON.stringify({type:'stdout',data:m.data})+'\\n');
 if(m.type==='end'){socket.write(JSON.stringify({type:'exit',code:0})+'\\n');socket.end();}
});
socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));
`;
describe("Windows Terminal SDK transport", () => {
  it("starts the worker while the window still paints, then records the single post-frame minimization", async () => {
    const abort = new AbortController();
    const process = new TerminalProcess(
      {
        command: "fixture",
        args: [],
        env: { ANTHROPIC_MODEL: "configured-model" },
        signal: abort.signal,
      },
      {
        launch(info, window) {
          const helper = spawn(globalThis.process.execPath, ["-e", script, info.pipe, info.token], {
            windowsHide: true,
            stdio: "ignore",
          });
          helpers.push(helper);
          // Production shape: created minimized (spawn intent) but currently painting unminimized
          // behind the foreground window. The old "must already be minimized" gate would have failed.
          setTimeout(
            () =>
              window({
                handle: "0",
                pid: 0,
                launchedMinimized: true,
                minimized: false,
                launchMs: 1,
                stage: "painting",
              }),
            30
          );
        },
      }
    );
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    const done = once(process, "exit");
    const input = Buffer.from("中文路径\n");
    process.stdin.end(input);
    await done;
    // The fixture only answers `start`, so this output proves the worker was started while the
    // window was still unminimized — a "must already be minimized" gate would deadlock here.
    expect(Buffer.concat(output).toString()).toBe("configured-model中文路径\n");
    // The minimization recorded here comes from the host's post-frame report, not from the claim.
    expect(process.info.startedMinimized).toBe(true);
    expect(process.info.firstFramePainted).toBe(true);
    expect(process.info.firstFrameMs).toBe(12);
    expect(process.info.userRestored).toBeUndefined();
    expect(process.info.paintedColumns).toBe(120);
    expect(process.info.paintedRows).toBe(36);
    expect(terminalInfo()).toEqual([]);
  });
  it("never claims minimized when the user restored the window before the first frame", async () => {
    const restored = `
const net=require('node:net'),readline=require('node:readline');
const [pipe,token]=process.argv.slice(1);
const socket=net.connect(pipe,()=>socket.write(JSON.stringify({type:'hello',token,pid:process.pid})+'\\n'));
readline.createInterface({input:socket}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='start'){socket.write(JSON.stringify({type:'spawned',pid:process.pid})+'\\n');socket.write(JSON.stringify({type:'ready',firstFrameMs:20,firstFramePainted:true,minimized:false,userRestored:true,paintedRevision:4,columns:100,rows:30,conversations:1})+'\\n');}
 if(m.type==='end'){socket.write(JSON.stringify({type:'exit',code:0})+'\\n');socket.end();}
});
socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));
`;
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: new AbortController().signal },
      {
        launch(info, window) {
          const helper = spawn(
            globalThis.process.execPath,
            ["-e", restored, info.pipe, info.token],
            {
              windowsHide: true,
              stdio: "ignore",
            }
          );
          helpers.push(helper);
          setTimeout(
            () =>
              window({
                handle: "0",
                pid: 0,
                launchedMinimized: true,
                minimized: false,
                launchMs: 1,
              }),
            20
          );
        },
      }
    );
    const done = once(process, "exit");
    process.stdin.end("done");
    await done;
    expect(process.info.firstFramePainted).toBe(true);
    expect(process.info.userRestored).toBe(true);
    expect(process.info.startedMinimized).toBe(false);
    expect(terminalInfo()).toEqual([]);
  });
  it("forwards a launcher-observed user restore so the host never buries or minimizes", async () => {
    // The launcher saw the user take the window during its startup settle. That decision is final:
    // it must reach the host as `windowRestoredAtLaunch` so the single post-frame minimization is
    // skipped, instead of the host re-burying/re-minimizing a window the user already owns.
    const restoredClaim = `
const net=require('node:net'),readline=require('node:readline');
const [pipe,token]=process.argv.slice(1);
const socket=net.connect(pipe,()=>socket.write(JSON.stringify({type:'hello',token,pid:process.pid})+'\\n'));
readline.createInterface({input:socket}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='start'){socket.write(JSON.stringify({type:'spawned',pid:process.pid})+'\\n');const ok=m.windowRestoredAtLaunch===true&&m.inputBaseline===4242;socket.write(JSON.stringify({type:'stdout',data:Buffer.from(ok?'forwarded':'lost').toString('base64')})+'\\n');socket.write(JSON.stringify({type:'ready',firstFrameMs:9,firstFramePainted:true,minimized:false,userRestored:true})+'\\n');}
 if(m.type==='end'){socket.write(JSON.stringify({type:'exit',code:0})+'\\n');socket.end();}
});
socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));
`;
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: new AbortController().signal },
      {
        launch(info, window) {
          const helper = spawn(
            globalThis.process.execPath,
            ["-e", restoredClaim, info.pipe, info.token],
            { windowsHide: true, stdio: "ignore" }
          );
          helpers.push(helper);
          setTimeout(
            () =>
              window({
                handle: "0",
                pid: 0,
                launchedMinimized: true,
                minimized: false,
                inputBaseline: 4242,
                userRestoredAtLaunch: true,
                launchMs: 1,
              }),
            20
          );
        },
      }
    );
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    const done = once(process, "exit");
    process.stdin.end("");
    await done;
    expect(Buffer.concat(output).toString()).toBe("forwarded");
    expect(process.info.userRestored).toBe(true);
    expect(process.info.startedMinimized).toBe(false);
    expect(terminalInfo()).toEqual([]);
  });
  it("does not deadlock when the host authenticates before the window is claimed", async () => {
    // The host's pump connects and sends `hello` while the launcher is still claiming the HWND.
    // Startup must wait for the claim rather than assuming it already happened, and must still
    // deliver the start message exactly once the claim arrives — no side waits on the other.
    const delayed = `
const net=require('node:net'),readline=require('node:readline');
const [pipe,token]=process.argv.slice(1);
const socket=net.connect(pipe,()=>socket.write(JSON.stringify({type:'hello',token,pid:process.pid})+'\\n'));
readline.createInterface({input:socket}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='start'){socket.write(JSON.stringify({type:'spawned',pid:process.pid})+'\\n');socket.write(JSON.stringify({type:'stdout',data:Buffer.from('started').toString('base64')})+'\\n');socket.write(JSON.stringify({type:'ready',firstFrameMs:5,firstFramePainted:true,minimized:true,userRestored:false})+'\\n');}
 if(m.type==='end'){socket.write(JSON.stringify({type:'exit',code:0})+'\\n');socket.end();}
});
socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));
`;
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: new AbortController().signal },
      {
        launch(info, window) {
          const helper = spawn(
            globalThis.process.execPath,
            ["-e", delayed, info.pipe, info.token],
            {
              windowsHide: true,
              stdio: "ignore",
            }
          );
          helpers.push(helper);
          // The claim lands well after the host's hello, which is the race that used to gate startup.
          setTimeout(
            () =>
              window({
                handle: "0",
                pid: 0,
                launchedMinimized: true,
                minimized: false,
                launchMs: 1,
              }),
            200
          );
        },
      }
    );
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    const done = once(process, "exit");
    process.stdin.end("");
    await done;
    expect(Buffer.concat(output).toString()).toBe("started");
    expect(process.info.windowHandle).toBe("0");
    expect(process.info.startedMinimized).toBe(true);
    expect(terminalInfo()).toEqual([]);
  });
  it("releases a startup cancelled while the window is still being claimed", async () => {
    const abort = new AbortController();
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: abort.signal },
      {
        // Claims are never delivered: cancellation must not wait for one.
        launch() {
          setTimeout(() => abort.abort(), 50);
        },
      }
    );
    const done = once(process, "exit");
    await done;
    expect(process.killed).toBe(true);
    expect(process.exitCode).toBeNull();
    expect(terminalInfo()).toEqual([]);
  });
  it("starts and exits normally when the host reports no first-frame readiness", async () => {
    const silent = `
const net=require('node:net'),readline=require('node:readline');
const [pipe,token]=process.argv.slice(1);
const socket=net.connect(pipe,()=>socket.write(JSON.stringify({type:'hello',token,pid:process.pid})+'\\n'));
readline.createInterface({input:socket}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.type==='start')socket.write(JSON.stringify({type:'spawned',pid:process.pid})+'\\n');
 if(m.type==='stdin')socket.write(JSON.stringify({type:'stdout',data:m.data})+'\\n');
 if(m.type==='end'){socket.write(JSON.stringify({type:'exit',code:0})+'\\n');socket.end();}
});
socket.on('close',()=>process.exit(0));socket.on('error',()=>process.exit(1));
`;
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: new AbortController().signal },
      {
        launch(info, window) {
          const helper = spawn(globalThis.process.execPath, ["-e", silent, info.pipe, info.token], {
            windowsHide: true,
            stdio: "ignore",
          });
          helpers.push(helper);
          // Legacy-shaped claim (no `launchedMinimized`): an already-minimized window is accepted.
          setTimeout(() => window({ handle: "0", pid: 0, minimized: true, launchMs: 1 }), 20);
        },
      }
    );
    const output: Buffer[] = [];
    process.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    const done = once(process, "exit");
    process.stdin.end("still delivered");
    await done;
    // Readiness is advisory: the session still starts, streams and finishes.
    expect(Buffer.concat(output).toString()).toBe("still delivered");
    expect(process.info.workerPid).toBeGreaterThan(0);
    expect(process.info.firstFramePainted).toBeUndefined();
    expect(terminalInfo()).toEqual([]);
  });
  it("fails explicitly when window launch fails", async () => {
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: new AbortController().signal },
      {
        launch(_info, _window, error) {
          setImmediate(() => error(new Error("fixture launch failure")));
        },
      }
    );
    const error = once(process, "error");
    await error;
    expect(process.exitCode).toBe(1);
    expect(terminalInfo()).toEqual([]);
  });
  it("cancels startup and releases its owned transport", async () => {
    const abort = new AbortController();
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: abort.signal },
      { launch() {} }
    );
    const done = once(process, "exit");
    abort.abort();
    await done;
    expect(process.killed).toBe(true);
    expect(terminalInfo()).toEqual([]);
  });
  it("times out instead of silently switching to hidden execution", async () => {
    const process = new TerminalProcess(
      { command: "fixture", args: [], env: {}, signal: new AbortController().signal },
      { launch() {}, startupTimeoutMs: 20 }
    );
    const [error] = await once(process, "error");
    expect(error.message).toContain("startup timed out");
    expect(terminalInfo()).toEqual([]);
  });
});
