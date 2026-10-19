package pufferpanel

import (
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pufferpanel/pufferpanel/v3/logging"
)

// socketQueueSize bounds how far a live client may fall behind before the
// tracker stops queueing frames and drops it.
const socketQueueSize = 1024

// socketWriteTimeout bounds one frame write so a peer that stalls mid-frame
// cannot pin its writer forever.
const socketWriteTimeout = 30 * time.Second

type Tracker struct {
	sockets []*Socket
	locker  sync.Mutex
}

func CreateTracker() *Tracker {
	return &Tracker{sockets: make([]*Socket, 0)}
}

func (ws *Tracker) Register(conn *Socket) {
	ws.locker.Lock()
	defer ws.locker.Unlock()
	ws.sockets = append(ws.sockets, conn)
}

// WriteMessage queues msg for every registered socket without blocking on any
// of them. Each socket drains its own queue with a single writer goroutine, so
// a client receives frames in the order the tracker observed them, which a
// goroutine-per-message dispatch did not guarantee (upstream issue #1450).
// Sockets that are closed or too far behind are dropped instead of stalling
// the console path that feeds the tracker.
func (ws *Tracker) WriteMessage(msg Transmission) error {
	d, err := json.Marshal(&msg)
	if err != nil {
		return err
	}
	ws.locker.Lock()
	defer ws.locker.Unlock()

	kept := ws.sockets[:0]
	for _, conn := range ws.sockets {
		if conn.Enqueue(d) {
			kept = append(kept, conn)
		}
	}
	for i := len(kept); i < len(ws.sockets); i++ {
		ws.sockets[i] = nil
	}
	ws.sockets = kept
	return nil
}

func (ws *Tracker) Write(source []byte) (n int, e error) {
	packet := ServerLogs{Logs: source}
	e = ws.WriteMessage(Transmission{
		Message: packet,
		Type:    MessageTypeLog,
	})
	n = len(source)
	return
}

func Create(ws *websocket.Conn) *Socket {
	socket := &Socket{
		conn:  ws,
		dead:  make(chan struct{}),
		queue: make(chan []byte, socketQueueSize),
	}
	go socket.writeLoop()
	return socket
}

type Socket struct {
	conn  *websocket.Conn
	dead  chan struct{}
	once  sync.Once
	queue chan []byte
	io.WriteCloser
}

// Enqueue queues one pre-marshaled frame and never blocks. It reports false
// when the socket is shut down or its client is too far behind, and callers
// treat that as a signal to drop the socket.
func (s *Socket) Enqueue(frame []byte) bool {
	select {
	case <-s.dead:
		return false
	default:
	}
	select {
	case s.queue <- frame:
		return true
	default:
		logging.Debug.Printf("websocket client is too far behind, dropping it")
		s.Close()
		return false
	}
}

func (s *Socket) writeLoop() {
	for {
		select {
		case frame := <-s.queue:
			_ = s.conn.SetWriteDeadline(time.Now().Add(socketWriteTimeout))
			if err := s.conn.WriteMessage(websocket.TextMessage, frame); err != nil {
				logging.Debug.Printf("websocket encountered error, dropping (%s)", err.Error())
				s.Close()
				return
			}
		case <-s.dead:
			return
		}
	}
}

func (s *Socket) WriteMessage(msg Transmission) error {
	return s.WriteJSON(&msg)
}

func (s *Socket) Write(data []byte) (n int, err error) {
	if !s.Enqueue(data) {
		return 0, errors.New("websocket client is closed or too far behind")
	}
	return len(data), nil
}

func (s *Socket) WriteJSON(data interface{}) error {
	d, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = s.Write(d)
	return err
}

func (s *Socket) Close() error {
	var err error
	s.once.Do(func() {
		close(s.dead)
		err = s.conn.Close()
	})
	return err
}
