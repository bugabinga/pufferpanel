package pufferpanel

import (
	"github.com/pufferpanel/pufferpanel/v3/config"
	"sync"
	"time"
)

type cacheMessage struct {
	msg  []byte
	time int64
}

type MemoryCache struct {
	Buffer   []cacheMessage
	Capacity int
	Size     int
	Lock     sync.RWMutex

	// lastTs is the newest timestamp handed to a stored message or returned
	// as a polling epoch. Writes only allocate strictly newer timestamps,
	// which keeps the ReadFrom `time > startTime` filter lossless even when
	// a write and a poll land in the same wall-clock microsecond.
	lastTs int64

	// now supplies UnixMicro timestamps. Tests may freeze it; production
	// always uses the wall clock.
	now func() int64
}

func CreateCache() *MemoryCache {
	capacity := config.ConsoleBuffer.Value()
	if capacity <= 0 {
		capacity = 50
	}
	return &MemoryCache{
		Buffer:   make([]cacheMessage, 0),
		Capacity: capacity * 1024, //convert to KB
		now:      func() int64 { return time.Now().UnixMicro() },
	}
}

func (c *MemoryCache) Read() (msg []byte, lastTime int64) {
	msg, lastTime = c.ReadFrom(0)
	return
}

// ReadFrom returns every buffered message newer than startTime plus the epoch
// a client should pass as startTime on its next poll. Raising lastTs while
// holding the write lock guarantees any message written after this read gets a
// strictly newer timestamp than the returned epoch, so the next poll cannot
// skip it; before that guarantee, a write landing in the same microsecond as
// the poll's timestamp was dropped from polling results until the buffer was
// replayed from zero (upstream issue #1439 symptom).
func (c *MemoryCache) ReadFrom(startTime int64) (msg []byte, lastTime int64) {
	c.Lock.Lock()
	defer c.Lock.Unlock()

	if t := c.now(); t > c.lastTs {
		c.lastTs = t
	}
	lastTime = c.lastTs

	msg = make([]byte, 0)

	for _, v := range c.Buffer {
		if v.time > startTime {
			msg = append(msg, v.msg...)
		}
	}

	return
}

func (c *MemoryCache) Write(b []byte) (n int, err error) {
	c.Lock.Lock()
	defer c.Lock.Unlock()
	n = len(b)

	//remove data until we've gotten small enough
	//a single write larger than the whole capacity empties the buffer and must
	//not index into it; that oversize message is kept once and evicted first
	//on the next write, so the cache stays bounded without panicking
	var pop cacheMessage
	for c.Size+n > c.Capacity && len(c.Buffer) > 0 {
		pop, c.Buffer = c.Buffer[0], c.Buffer[1:]
		c.Size = c.Size - len(pop.msg)
	}

	co := make([]byte, len(b))
	copy(co, b)

	ts := c.now()
	if ts <= c.lastTs {
		ts = c.lastTs + 1
	}
	c.lastTs = ts

	c.Buffer = append(c.Buffer, cacheMessage{msg: co, time: ts})
	c.Size = c.Size + n
	return
}
