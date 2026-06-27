# 🛡️ Gatekeeper Shell

> A **secure, collaborative, browser-based terminal** for your POSIX-style shell. Share your terminal with guests — but you decide what runs.

![Go](https://img.shields.io/badge/Go-1.21+-00ADD8?style=flat-square&logo=go)
![WebSocket](https://img.shields.io/badge/WebSocket-Real--time-brightgreen?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

---

## 🌟 What Is This?

**Gatekeeper Shell** is a Go-powered WebSocket server that wraps your local terminal and exposes it securely through a browser UI. It supports two roles:

| Role | What they can do |
|------|-----------------|
| **Host** | Direct control of the terminal. All keystrokes go straight to the shell. Sees and approves/denies guest commands. |
| **Guest** | Types commands which are sent to the Host for approval. Commands only execute if the Host approves them. |

This means you can **safely share your terminal** with collaborators, pair programmers, students, or demo viewers — with full command control.

---

## ✨ Features

- **🔒 Host-gated command execution** — guests cannot run anything without approval
- **⚡ Real-time WebSocket streaming** — stdout/stderr streamed live to all viewers  
- **🖥️ Beautiful glassmorphic terminal UI** — dark mode, JetBrains Mono font, Mac-style window
- **⌨️ Tab completion** — backed by real filesystem + PATH search via Go
- **📜 Command history** — Arrow keys navigate history (host and guest)
- **🎯 Role-based UI** — Hosts see the approval overlay; guests see a pending indicator

---

## 🚀 Quick Start

### Prerequisites

- [Go 1.21+](https://go.dev/dl/)
- [Node.js 18+](https://nodejs.org/) (the underlying POSIX shell runs on Node.js)

### 1. Clone & Build

```bash
# From the project root (codecrafters-shell-javascript/)
cd go-gatekeeper
go mod tidy
go build -o gatekeeper.exe .   # Windows
# go build -o gatekeeper .     # Linux/macOS
```

### 2. Run the Server

```bash
./gatekeeper.exe    # Windows
# ./gatekeeper      # Linux/macOS
```

The server starts at **http://localhost:8080**

### 3. Open the Terminal

| Who | URL |
|-----|-----|
| **Host (you)** | http://localhost:8080?role=host |
| **Guest (collaborator)** | http://localhost:8080?role=guest |

---

## Architecture

```
Browser (Host)  <--->  |
Browser (Guest) <--->  |---  Go WebSocket Server (port 8080)
Browser (Guest) <--->  |             |
                                     | stdin/stdout/stderr pipes
                                Node.js Shell Process (app/main.js)
```

The Go server acts as a **gatekeeper**:
1. Spawns the Node.js POSIX shell as a child process
2. Connects all browsers via WebSocket
3. Host keystrokes go directly to shell stdin
4. Guest commands are held pending, shown to Host, approved/denied, then executed or dropped
5. Shell stdout/stderr broadcasts to ALL connected browsers

---

## Security Model

- The **Host** is the owner of the machine — they have full terminal access.
- **Guests** submit commands but **cannot execute anything without explicit host approval**.
- There is no authentication layer by default — only share the guest link with trusted people.

> **Warning**: The Host URL gives full terminal access. Never share `?role=host` with untrusted users.

---

## Project Structure

```
go-gatekeeper/
├── main.go          # Go WebSocket server + shell subprocess manager
├── go.mod           # Go module definition
├── go.sum           # Dependency checksums
├── gatekeeper.exe   # Compiled binary (after build)
└── web/
    ├── index.html   # Terminal UI
    ├── shell.js     # WebSocket client + terminal emulator logic
    └── styles.css   # Glassmorphic dark terminal theme
```

---

## Exposing to the Internet (ngrok)

```bash
# Terminal 1: Start gatekeeper
./gatekeeper.exe

# Terminal 2: Tunnel port 8080
ngrok http 8080
```

Share the ngrok URL as `https://your-ngrok-url.ngrok.io?role=guest` with guests.
Keep `http://localhost:8080?role=host` for yourself.

---

## License

MIT License. Built on top of the [codecrafters-shell-javascript](https://github.com/VishalRaut2106/codecrafters-shell-javascript) project.
