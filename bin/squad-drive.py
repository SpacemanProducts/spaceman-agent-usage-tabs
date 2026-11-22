#!/usr/bin/env python3
"""Open ONE Claude Squad window and start one session in it per agent.

cs has no command line for creating sessions: you press `n`, type a name and press Enter. So this types those keys
for you. Usage: squad-drive.py <repo-dir> <agent-cli>...  (run it in the terminal that should hold Squad)

Each agent but the last runs `cs -p <agent>` out of sight: press n, type a name, Enter, wait for the session, ctrl-q back to the list, quit
(sessions keep running in tmux and cs lists them again next time). The last agent's cs is the one you see and use, with
its own session started the same way. Sessions keep the program they were created with.
"""
import fcntl, os, pty, re, select, signal, struct, subprocess, sys, termios, time, tty

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]")

def winsize():
    try: return fcntl.ioctl(0, termios.TIOCGWINSZ, b"\0" * 8)
    except OSError: return struct.pack("HHHH", 40, 140, 0, 0)

def spawn(cmd):
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize())
    return pid, fd

class Cs:
    def __init__(self, program, show):
        self.show, self.buf = show, b""
        self.pid, self.fd = spawn(["cs", "-p", program])
    def pump(self, timeout=0.2):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if not r: return True
        try: data = os.read(self.fd, 65536)
        except OSError: return False
        if not data: return False
        self.buf = (self.buf + data)[-20000:]
        if self.show: os.write(1, data)
        return True
    def text(self): return ANSI.sub(b"", self.buf).decode("utf8", "replace")
    def wait_for(self, needle, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if needle in self.text(): return True
            if not self.pump(): return False
        return needle in self.text()
    def send(self, s, gap=0.03):
        for ch in s:
            os.write(self.fd, ch.encode()); time.sleep(gap); self.pump(0)
    def alive(self):
        try: return os.waitpid(self.pid, os.WNOHANG) == (0, 0)
        except ChildProcessError: return False

def sessions():
    out = subprocess.run(["tmux", "ls", "-F", "#{session_name}"], capture_output=True, text=True).stdout
    return set(out.split())

def start_session(cs, title):
    """n, name, Enter. True once a new tmux session shows up."""
    before = sessions()
    cs.wait_for("n new", 12); time.sleep(0.5)
    cs.send("n")
    if not cs.wait_for("enter submit name", 8): return False
    cs.send(title); time.sleep(0.3); cs.send("\r")
    end = time.time() + 20
    while time.time() < end:
        if sessions() - before: break
        cs.pump(0.3)
    else:
        return False
    # cs attaches you to a new session at once; ctrl-q detaches back to its list.
    time.sleep(1.5); cs.pump(0.2)
    cs.buf = b""
    cs.send("\x11")
    return cs.wait_for("n new", 8)

def main():
    repo, agents = sys.argv[1], sys.argv[2:]
    os.chdir(repo)
    stamp = time.strftime("%H%M")
    for i, agent in enumerate(agents):
        last = i == len(agents) - 1
        print(f"Starting {agent} ({i + 1}/{len(agents)})...", flush=True)
        cs = Cs(agent, show=last)
        ok = start_session(cs, f"{agent}-{stamp}")
        if not ok: print(f"  (couldn't confirm the {agent} session; open it with n)", flush=True)
        if last: return interactive(cs)
        cs.send("q"); time.sleep(0.5)
        for _ in range(30):
            cs.pump(0.1)
            if not cs.alive(): break
        else:
            os.kill(cs.pid, signal.SIGTERM)
        time.sleep(0.3)

def interactive(cs):
    old = termios.tcgetattr(0)
    tty.setraw(0)
    signal.signal(signal.SIGWINCH, lambda *_: fcntl.ioctl(cs.fd, termios.TIOCSWINSZ, winsize()))
    try:
        while True:
            r, _, _ = select.select([0, cs.fd], [], [], 0.5)
            if 0 in r:
                data = os.read(0, 65536)
                if not data: break
                os.write(cs.fd, data)
            if cs.fd in r:
                try: data = os.read(cs.fd, 65536)
                except OSError: break
                if not data: break
                os.write(1, data)
            if not cs.alive(): break
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, old)

if __name__ == "__main__":
    main()
