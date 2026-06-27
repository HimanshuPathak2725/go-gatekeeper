package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

const PORT = ":8080"

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

/* ─── PROTOCOL ────────────────────────────────────────────── */

type Message struct {
	Type    string   `json:"type"`
	Data    string   `json:"data,omitempty"`
	Command string   `json:"command,omitempty"`
	Msg     string   `json:"msg,omitempty"`
	Hits    []string `json:"hits,omitempty"`
	Prefix  string   `json:"prefix,omitempty"`
	// room-aware fields
	RoomCode string `json:"roomCode,omitempty"`
	GuestURL string `json:"guestURL,omitempty"`
	Queue    int    `json:"queue,omitempty"` // # of items still in queue
}

/* ─── ROOM ────────────────────────────────────────────────── */

type PendingCmd struct {
	Command string
	Guest   *websocket.Conn
}

// Room is one isolated host+guests+shell session.
type Room struct {
	mu   sync.Mutex
	Code string

	Host   *websocket.Conn
	Guests map[*websocket.Conn]bool

	shellIn   io.WriteCloser
	shellBusy bool // true while shell is executing a command

	active *PendingCmd  // command currently awaiting host approval
	queue  []PendingCmd // commands waiting in line
}

/* ─── GLOBAL STATE ────────────────────────────────────────── */

var (
	roomsMu sync.RWMutex
	rooms   = make(map[string]*Room)
	baseDir string
)

func init() {
	if p, err := os.Executable(); err == nil {
		d := filepath.Dir(p)
		if _, err2 := os.Stat(filepath.Join(d, "web")); err2 == nil {
			baseDir = d
			return
		}
	}
	baseDir = "."
}

/* ─── UTIL ────────────────────────────────────────────────── */

func generateCode() string {
	b := make([]byte, 3)
	rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func getLocalIP() string {
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok {
				if ip4 := ipnet.IP.To4(); ip4 != nil {
					return ip4.String()
				}
			}
		}
	}
	return "localhost"
}

func guestURL(code string) string {
	port := strings.TrimPrefix(PORT, ":")
	return fmt.Sprintf("http://%s:%s?role=guest&code=%s", getLocalIP(), port, code)
}

/* ─── ROOM LIFECYCLE ──────────────────────────────────────── */

func newRoom() *Room {
	// unique code
	var code string
	roomsMu.Lock()
	for {
		code = generateCode()
		if _, exists := rooms[code]; !exists {
			break
		}
	}
	r := &Room{
		Code:   code,
		Guests: make(map[*websocket.Conn]bool),
	}
	rooms[code] = r
	roomsMu.Unlock()

	r.startShell()
	log.Printf("[room %s] created", code)
	return r
}

func (r *Room) destroy() {
	roomsMu.Lock()
	delete(rooms, r.Code)
	roomsMu.Unlock()

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.shellIn != nil {
		r.shellIn.Close()
	}
	for g := range r.Guests {
		g.WriteJSON(Message{Type: "stderr", Data: "\nHost disconnected — session ended.\n"})
		g.Close()
	}
	log.Printf("[room %s] destroyed", r.Code)
}

func (r *Room) startShell() {
	script := filepath.Join(baseDir, "system_shell.js")
	cmd := exec.Command("node", script)
	cmd.Env = append(os.Environ(),
		"TERM=dumb",
		"GATEKEEPER_SESSION_CODE="+r.Code,
		"GATEKEEPER_IP="+getLocalIP(),
		"GATEKEEPER_PORT="+strings.TrimPrefix(PORT, ":"),
	)

	var err error
	r.shellIn, err = cmd.StdinPipe()
	if err != nil {
		log.Printf("[room %s] StdinPipe: %v", r.Code, err)
		return
	}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		log.Printf("[room %s] shell start: %v", r.Code, err)
		return
	}

	go r.pipeOutput(stdout, "stdout")
	go r.pipeOutput(stderr, "stderr")
	go func() {
		cmd.Wait()
		log.Printf("[room %s] shell exited", r.Code)
		r.broadcast(Message{Type: "exit"})
	}()
}

/* ─── OUTPUT STREAMING ────────────────────────────────────── */

func (r *Room) pipeOutput(src io.Reader, msgType string) {
	buf := make([]byte, 4096)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			data := string(buf[:n])
			r.broadcast(Message{Type: msgType, Data: data})

			// Detect shell prompt → previous command finished, advance queue
			if msgType == "stdout" && r.isPrompt(data) {
				r.mu.Lock()
				if r.shellBusy {
					r.shellBusy = false
					r.processNext()
				}
				r.mu.Unlock()
			}
		}
		if err != nil {
			if err != io.EOF {
				log.Printf("[room %s] pipe[%s]: %v", r.Code, msgType, err)
			}
			break
		}
	}
}

// isPrompt reports whether data contains the shell prompt "\n$ " or is the initial "$ "
func (r *Room) isPrompt(data string) bool {
	trimmed := strings.TrimRight(data, " \n")
	return data == "$ " || data == "$ \n" ||
		strings.HasSuffix(trimmed, "\n$") ||
		strings.Contains(data, "\n$ ")
}

/* ─── BROADCAST ───────────────────────────────────────────── */

func (r *Room) broadcast(msg Message) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.Host != nil {
		if err := r.Host.WriteJSON(msg); err != nil {
			log.Printf("[room %s] host write err: %v", r.Code, err)
		}
	}
	for g := range r.Guests {
		if err := g.WriteJSON(msg); err != nil {
			log.Printf("[room %s] guest write err, removing", r.Code)
			delete(r.Guests, g)
			g.Close()
		}
	}
}

/* ─── COMMAND QUEUE ───────────────────────────────────────── */

func (r *Room) guestSubmit(conn *websocket.Conn, cmd string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.queue = append(r.queue, PendingCmd{Command: cmd, Guest: conn})

	if r.active == nil && !r.shellBusy {
		// Nothing running — promote to active immediately
		r.processNext()
	} else {
		pos := len(r.queue)
		conn.WriteJSON(Message{
			Type:  "status",
			Msg:   fmt.Sprintf("Queued (position %d) — waiting for current command…", pos),
			Queue: pos,
		})
	}
}

// processNext advances the queue. Must be called with r.mu held.
func (r *Room) processNext() {
	if len(r.queue) == 0 {
		r.active = nil
		return
	}

	next := r.queue[0]
	r.queue = r.queue[1:]
	r.active = &next

	// Tell guest they're up
	next.Guest.WriteJSON(Message{
		Type: "status",
		Msg:  "Waiting for host approval…",
	})

	// Ask host — include remaining queue length
	if r.Host != nil {
		r.Host.WriteJSON(Message{
			Type:    "approval_request",
			Command: next.Command,
			Queue:   len(r.queue),
		})
	}
}

func (r *Room) hostApprove() {
	r.mu.Lock()
	active := r.active
	r.active = nil
	r.mu.Unlock()

	if active == nil {
		return
	}

	// Release guest's waiting status
	active.Guest.WriteJSON(Message{Type: "status", Msg: ""})

	// Execute in shell — mark busy so processNext waits for prompt
	r.mu.Lock()
	r.shellBusy = true
	r.mu.Unlock()

	if r.shellIn != nil {
		r.shellIn.Write([]byte(active.Command + "\n"))
	}
	// processNext called by pipeOutput when shell prompt detected
}

func (r *Room) hostDeny() {
	r.mu.Lock()
	active := r.active
	r.active = nil
	r.mu.Unlock()

	if active == nil {
		return
	}

	// Tell only this guest it was denied
	active.Guest.WriteJSON(Message{Type: "status", Msg: ""})
	active.Guest.WriteJSON(Message{Type: "stderr", Data: "\nCommand denied by host.\n"})
	active.Guest.WriteJSON(Message{Type: "stdout", Data: "\n$ "})

	// Process next queued command
	r.mu.Lock()
	r.processNext()
	r.mu.Unlock()
}

/* ─── WEBSOCKET HANDLER ───────────────────────────────────── */

func handleWebSocket(w http.ResponseWriter, req *http.Request) {
	role := req.URL.Query().Get("role")
	if role != "host" {
		role = "guest"
	}

	conn, err := upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Printf("WS upgrade: %v", err)
		return
	}

	if role == "host" {
		r := newRoom()
		r.mu.Lock()
		r.Host = conn
		r.mu.Unlock()

		// Tell host their room info
		conn.WriteJSON(Message{
			Type:     "room_info",
			RoomCode: r.Code,
			GuestURL: guestURL(r.Code),
		})

		log.Printf("[room %s] host connected", r.Code)
		go readerLoop(conn, "host", r)

	} else {
		code := req.URL.Query().Get("code")
		roomsMu.RLock()
		r, ok := rooms[code]
		roomsMu.RUnlock()

		if !ok || code == "" {
			conn.WriteJSON(Message{
				Type: "stderr",
				Data: "Invalid or expired session code.",
			})
			conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(4001, "invalid code"))
			conn.Close()
			return
		}

		r.mu.Lock()
		r.Guests[conn] = true
		r.mu.Unlock()

		log.Printf("[room %s] guest connected", r.Code)
		go readerLoop(conn, "guest", r)
	}
}

func readerLoop(conn *websocket.Conn, role string, r *Room) {
	defer func() {
		r.mu.Lock()
		if role == "host" {
			if r.Host == conn {
				r.Host = nil
			}
		} else {
			delete(r.Guests, conn)
		}
		r.mu.Unlock()
		conn.Close()

		if role == "host" {
			log.Printf("[room %s] host disconnected", r.Code)
			r.destroy()
		} else {
			log.Printf("[room %s] guest disconnected", r.Code)
		}
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg Message
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "stdin":
			if role == "host" && r.shellIn != nil {
				r.shellIn.Write([]byte(msg.Data))
			}
		case "submit_command":
			if role == "guest" {
				r.guestSubmit(conn, msg.Command)
			}
		case "approve_command":
			if role == "host" {
				r.hostApprove()
			}
		case "deny_command":
			if role == "host" {
				r.hostDeny()
			}
		case "complete":
			doComplete(conn, msg.Command)
		}
	}
}

/* ─── /api/rooms ──────────────────────────────────────────── */

func handleRooms(w http.ResponseWriter, req *http.Request) {
	type RoomInfo struct {
		Code     string `json:"code"`
		GuestURL string `json:"guestURL"`
		Guests   int    `json:"guests"`
		Queue    int    `json:"queue"`
	}

	roomsMu.RLock()
	var list []RoomInfo
	for code, rm := range rooms {
		rm.mu.Lock()
		list = append(list, RoomInfo{
			Code:     code,
			GuestURL: guestURL(code),
			Guests:   len(rm.Guests),
			Queue:    len(rm.queue),
		})
		rm.mu.Unlock()
	}
	roomsMu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"rooms": list,
		"total": len(list),
	})
}

/* ─── MAIN ────────────────────────────────────────────────── */

func main() {
	webDir := filepath.Join(baseDir, "web")
	http.Handle("/", http.FileServer(http.Dir(webDir)))
	http.HandleFunc("/ws", handleWebSocket)
	http.HandleFunc("/api/rooms", handleRooms)

	ip := getLocalIP()
	port := strings.TrimPrefix(PORT, ":")

	fmt.Println()
	fmt.Println("╔══════════════════════════════════════════════════════════════╗")
	fmt.Println("║         🛡️   GATEKEEPER SHELL  —  MULTI-SESSION              ║")
	fmt.Println("╠══════════════════════════════════════════════════════════════╣")
	fmt.Printf( "║  Open as Host: http://localhost%s?role=host                 ║\n", PORT)
	fmt.Printf( "║  Each host tab creates its own isolated session.             ║\n")
	fmt.Printf( "║  Type 'share' in terminal to get the guest link.             ║\n")
	fmt.Printf( "║  Network: %-49s ║\n", ip+":"+port)
	fmt.Println("╚══════════════════════════════════════════════════════════════╝")
	fmt.Println()

	if err := http.ListenAndServe(PORT, nil); err != nil {
		log.Fatalf("Server: %v", err)
	}
}

/* ─── TAB COMPLETION ──────────────────────────────────────── */

func doComplete(conn *websocket.Conn, line string) {
	spaceIdx := strings.Index(line, " ")
	isArg := spaceIdx != -1

	var hits []string
	prefix := ""

	if !isArg {
		prefix = line
		commands := []string{
			"cd", "clear", "echo", "exit", "help", "pwd", "share", "status", "whoami",
			"cat", "ls", "grep", "find", "git", "node", "npm", "python", "python3",
		}
		for _, c := range commands {
			if strings.HasPrefix(c, prefix) {
				hits = append(hits, c)
			}
		}
		sep := ":"
		if os.PathListSeparator == ';' {
			sep = ";"
		}
		for _, p := range strings.Split(os.Getenv("PATH"), sep) {
			files, err := os.ReadDir(p)
			if err != nil {
				continue
			}
			for _, f := range files {
				name := f.Name()
				if !strings.HasPrefix(name, prefix) {
					continue
				}
				if os.PathListSeparator == ';' {
					if strings.HasSuffix(name, ".exe") || strings.HasSuffix(name, ".bat") || strings.HasSuffix(name, ".cmd") {
						name = name[:strings.LastIndex(name, ".")]
						hits = append(hits, name)
					}
				} else {
					hits = append(hits, name)
				}
			}
		}
	} else {
		lastSpace := strings.LastIndex(line, " ")
		prefix = line[lastSpace+1:]
		cwd, _ := os.Getwd()

		lastSlash := strings.LastIndex(prefix, "/")
		if os.PathListSeparator == ';' {
			if bs := strings.LastIndex(prefix, "\\"); bs > lastSlash {
				lastSlash = bs
			}
		}
		dirPart, filePart := "", prefix
		if lastSlash != -1 {
			dirPart = prefix[:lastSlash+1]
			filePart = prefix[lastSlash+1:]
		}
		searchDir := cwd
		if dirPart != "" {
			d := dirPart
			if strings.HasPrefix(d, "~") {
				home, _ := os.UserHomeDir()
				d = filepath.Join(home, d[1:])
			}
			if filepath.IsAbs(d) {
				searchDir = d
			} else {
				searchDir = filepath.Join(cwd, d)
			}
		}
		if files, err := os.ReadDir(searchDir); err == nil {
			for _, f := range files {
				name := f.Name()
				if !strings.HasPrefix(name, filePart) {
					continue
				}
				suffix := " "
				if f.IsDir() {
					suffix = "/"
				}
				hits = append(hits, dirPart+name+suffix)
			}
		}
	}

	hits = uniqueSorted(hits)
	conn.WriteJSON(Message{Type: "completions", Hits: hits, Prefix: prefix})
}

func uniqueSorted(s []string) []string {
	seen := make(map[string]bool)
	var out []string
	for _, v := range s {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}
