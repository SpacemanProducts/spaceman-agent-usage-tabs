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

def say(msg):
    """Print a progress line (and append it to $SQUAD_DRIVE_LOG when set, which the tests use)."""
    print(msg, flush=True)
    log = os.environ.get("SQUAD_DRIVE_LOG")
    if log:
        with open(log, "a") as f: f.write(msg + "\n")

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

STATE = os.path.join(os.path.expanduser("~"), ".claude-squad", "state.json")

def saved(title):
    """Is the session recorded in cs's own state file? (That is what lists it next time.)"""
    try:
        import json
        d = json.load(open(STATE)); inst = d.get("instances") or []
        inst = inst if isinstance(inst, list) else list(inst.values())
        return any(i.get("title") == title for i in inst)
    except Exception:
        return False

def wait_saved(title, timeout):
    end = time.time() + timeout
    while time.time() < end:
        if saved(title): return True
        time.sleep(0.4)
    return saved(title)

def close_extra_windows():
    """Only this Claude Squad window should be open: close any other one that appeared since it started."""
    raw = os.environ.get("SQUAD_WINDOWS_BEFORE")
    if raw is None: return                # not started from squad.sh: nothing to compare with
    before = {p for p in raw.split(",") if p}
    mine, p = set(), os.getpid()
    while p > 1:
        mine.add(str(p))
        try: p = int(open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()[1])
        except Exception: break
    try:
        import json
        clients = json.loads(subprocess.run(["hyprctl", "clients", "-j"], capture_output=True, text=True).stdout or "[]")
    except Exception:
        return
    for c in clients:
        pid = str(c.get("pid"))
        if c.get("class") == "org.omarchy.squad" and pid not in before and pid not in mine:
            subprocess.run(["hyprctl", "dispatch", "closewindow", f"pid:{pid}"], capture_output=True)

def sessions():
    out = subprocess.run(["tmux", "ls", "-F", "#{session_name}"], capture_output=True, text=True).stdout
    return set(out.split())

def alive(name):
    return subprocess.run(["tmux", "has-session", "-t", f"={name}"], capture_output=True).returncode == 0

def start_session(cs, title):
    """n, name, Enter, then back to cs's list.
    Returns (started, listed): `started` = the agent's program is running in its tmux session. That is all "started"
    means: an agent sitting at a trust or login prompt has started fine. It is False only if the session never appeared
    or its program died straight away. `listed` = we got back to cs's list (so it can save the session)."""
    before = sessions()
    cs.wait_for("n new", 12); time.sleep(0.5)
    cs.send("n")
    if not cs.wait_for("enter submit name", 8): return False, False
    cs.send(title); time.sleep(0.3); cs.send("\r")
    end, name = time.time() + 25, None
    while time.time() < end:
        new = sessions() - before
        if new: name = sorted(new)[0]; break
        cs.pump(0.3)
    if not name: return False, False
    time.sleep(2.0); cs.pump(0.2)
    if not alive(name): return False, False          # its program exited right away: a real failure
    # cs attached us to the new session. Detach with ctrl-q; if the agent (a trust or login prompt, say) swallows
    # the key, have tmux detach us instead. Either way the agent keeps running.
    for attempt in range(8):
        cs.buf = b""
        if attempt % 2 == 0: cs.send("\x11")
        else: subprocess.run(["tmux", "detach-client", "-s", name], capture_output=True)
        if cs.wait_for("n new", 4): return True, wait_saved(title, 10)
    return alive(name), False

def main():
    repo, agents = sys.argv[1], sys.argv[2:]
    os.chdir(repo)
    stamp = time.strftime("%H%M")
    for i, agent in enumerate(agents):
        last = i == len(agents) - 1
        say(f"Starting {agent} ({i + 1}/{len(agents)})...")
        cs = Cs(agent, show=last)
        title = f"{agent}-{stamp}"
        started, listed = start_session(cs, title)
        if not last:
            cs.send("q")
            for _ in range(100):             # let cs quit by itself and write its state (up to 10 s)
                cs.pump(0.1)
                if not cs.alive(): break
            else:
                os.kill(cs.pid, signal.SIGTERM)
            listed = listed and wait_saved(title, 5)
        if not started:
            say(f"  COULD NOT START: {agent} (the session never came up, or its program exited at once)")
        elif listed:
            say(f"  started: {agent}")
        else:
            say(f"  started: {agent} (running, but cs didn't list it; it may need a restart of cs)")
        if last:
            close_extra_windows()
            return interactive(cs)
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
