package pufferpanel

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// newSocketConn upgrades a websocket pair and returns both ends without
// starting any writer on the server side.
func newSocketConn(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()

	release := make(chan struct{})
	upgraded := make(chan *websocket.Conn, 1)
	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		upgraded <- conn
		<-release
		_ = conn.Close()
	}))
	t.Cleanup(func() {
		close(release)
		srv.Close()
	})

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("failed to dial test websocket: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	select {
	case serverConn := <-upgraded:
		return serverConn, client
	case <-time.After(5 * time.Second):
		t.Fatal("test websocket server never finished upgrading")
		return nil, nil
	}
}

// newSocketPair returns a server-side Socket wired to a writeLoop plus the
// client end of the connection. The client must be read from or frames will
// eventually stall against the write deadline.
func newSocketPair(t *testing.T) (*Socket, *websocket.Conn) {
	t.Helper()
	serverConn, client := newSocketConn(t)
	return Create(serverConn), client
}

func logTransmission(seq int) Transmission {
	return Transmission{
		Type: MessageTypeLog,
		Message: ServerLogs{
			Epoch: int64(seq),
		},
	}
}

// consoleFrame mirrors the on-the-wire shape of Transmission with the
// console payload typed, so tests can assert on it after JSON decoding.
type consoleFrame struct {
	Data ServerLogs       `json:"data"`
	Type TransmissionType `json:"type"`
}

func readFrame(t *testing.T, client *websocket.Conn) consoleFrame {
	t.Helper()
	var frame consoleFrame
	if err := client.ReadJSON(&frame); err != nil {
		t.Fatalf("read frame: %v", err)
	}
	return frame
}

// TestTrackerDeliversInDispatchOrder is the regression test for upstream
// issue #1450: a flood of console messages must reach a client in the order
// the tracker dispatched them, not in whatever order per-message goroutines
// happened to win the race.
func TestTrackerDeliversInDispatchOrder(t *testing.T) {
	socket, client := newSocketPair(t)
	tracker := CreateTracker()
	tracker.Register(socket)

	const total = 256
	go func() {
		for i := 0; i < total; i++ {
			if err := tracker.WriteMessage(logTransmission(i)); err != nil {
				return
			}
		}
	}()

	for want := 0; want < total; want++ {
		frame := readFrame(t, client)
		if int64(want) != frame.Data.Epoch {
			t.Fatalf("frame %d arrived out of order, got epoch %d", want, frame.Data.Epoch)
		}
		if frame.Type != MessageTypeLog {
			t.Fatalf("frame %d has type %q, want %q", want, frame.Type, MessageTypeLog)
		}
	}
}

// TestTrackerConcurrentDispatchKeepsPerSourceOrder hammers WriteMessage from
// many goroutines at once. The tracker serializes dispatch and each socket
// keeps one FIFO writer, so every source's messages must stay in order and
// none may be lost or duplicated while the lock is contended.
func TestTrackerConcurrentDispatchKeepsPerSourceOrder(t *testing.T) {
	socket, client := newSocketPair(t)
	tracker := CreateTracker()
	tracker.Register(socket)

	const sources = 8
	const perSource = 64

	var wg sync.WaitGroup
	for s := 0; s < sources; s++ {
		wg.Add(1)
		go func(src int) {
			defer wg.Done()
			for i := 0; i < perSource; i++ {
				msg := Transmission{
					Type: MessageTypeLog,
					Message: ServerLogs{
						Logs: []byte(fmt.Sprintf("%d:%d", src, i)),
					},
				}
				if err := tracker.WriteMessage(msg); err != nil {
					t.Errorf("WriteMessage: %v", err)
					return
				}
			}
		}(s)
	}

	next := make([]int, sources)
	received := 0
	for received < sources*perSource {
		frame := readFrame(t, client)
		var src, seq int
		if _, err := fmt.Sscanf(string(frame.Data.Logs), "%d:%d", &src, &seq); err != nil {
			t.Fatalf("frame %d: bad tag %q", received, frame.Data.Logs)
		}
		if src < 0 || src >= sources {
			t.Fatalf("frame %d: unknown source %d", received, src)
		}
		if seq != next[src] {
			t.Fatalf("source %d delivered %d, want %d (per-source order broken)", src, seq, next[src])
		}
		next[src]++
		received++
	}
	wg.Wait()

	if received != sources*perSource {
		t.Fatalf("received %d frames, want %d", received, sources*perSource)
	}
}

// TestSocketEnqueueDropsClientTooFarBehind verifies the bounded queue: a
// client that never reads past socketQueueSize frames is dropped instead of
// blocking the console path, and a dropped socket never accepts frames again.
// The socket is built without a writeLoop on purpose so nothing drains the
// queue while it fills.
func TestSocketEnqueueDropsClientTooFarBehind(t *testing.T) {
	serverConn, _ := newSocketConn(t)
	socket := &Socket{
		conn:  serverConn,
		dead:  make(chan struct{}),
		queue: make(chan []byte, socketQueueSize),
	}
	t.Cleanup(func() { _ = socket.Close() })

	frame := []byte(`{"type":"console"}`)
	for i := 0; i < socketQueueSize; i++ {
		if !socket.Enqueue(frame) {
			t.Fatalf("enqueue %d rejected before the queue was full", i)
		}
	}
	if socket.Enqueue(frame) {
		t.Fatal("enqueue past the queue limit was accepted, want the client dropped")
	}
	if socket.Enqueue(frame) {
		t.Fatal("enqueue on a dropped socket was accepted")
	}
}

// TestSocketEnqueueAfterClosed ensures a shut-down socket refuses new frames
// rather than silently queueing them for nobody.
func TestSocketEnqueueAfterClosed(t *testing.T) {
	socket, _ := newSocketPair(t)

	if err := socket.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if socket.Enqueue([]byte(`{}`)) {
		t.Fatal("enqueue on closed socket was accepted")
	}
}

// TestWriteMessageDropsDeadSockets verifies a dead client cannot poison the
// tracker for the sockets that are still alive.
func TestWriteMessageDropsDeadSockets(t *testing.T) {
	dead, _ := newSocketPair(t)
	if err := dead.Close(); err != nil {
		t.Fatalf("close dead socket: %v", err)
	}

	live, client := newSocketPair(t)

	tracker := CreateTracker()
	tracker.Register(dead)
	tracker.Register(live)

	for i := 0; i < 3; i++ {
		if err := tracker.WriteMessage(logTransmission(i)); err != nil {
			t.Fatalf("WriteMessage with dead socket registered: %v", err)
		}
	}

	for want := 0; want < 3; want++ {
		frame := readFrame(t, client)
		if int64(want) != frame.Data.Epoch {
			t.Fatalf("live client got epoch %d, want %d", frame.Data.Epoch, want)
		}
	}
}
