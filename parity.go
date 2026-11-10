package main

// Day 3: parity (the RAID 5 idea) across accounts.
//
// With N accounts, data is cut into stripes. Each stripe has N-1 data shards
// and 1 parity shard, every shard on a different account:
//
//	stripe 0:  D  D  D  P        P = D1 xor D2 xor D3
//	stripe 1:  D  D  P  D        the parity moves around, so no account
//	stripe 2:  D  P  D  D        holds all the parity
//
// If any one account is gone (closed, banned, deleted), its shard in each
// stripe is rebuilt by xor-ing the parity with the remaining shards.
// Space cost: one account's worth, not half like a full copy.

import (
	"errors"
	"fmt"
	"hash"
	"io"
	"net/url"
	"sort"
)

type stripe struct {
	Shards []chunk `json:"shards"` // data shards, in order
	Parity chunk   `json:"parity"`
}

func xorInto(dst, src []byte) {
	for i := range src {
		dst[i] ^= src[i]
	}
}

// putParity reads src to the end and stores it as parity stripes.
func putParity(be backend, accounts []string, src io.Reader, m *manifest, free map[string]int64, whole hash.Hash) error {
	k := len(accounts) - 1
	undo := func() {
		for _, s := range m.Stripes {
			for _, c := range append(s.Shards, s.Parity) {
				if c.FileID != "" {
					be.Delete(c.Account, c.FileID)
				}
			}
		}
	}
	upload := func(account string, idx int, part []byte) (chunk, error) {
		if free[account] < int64(len(part)) {
			return chunk{}, fmt.Errorf("account %s is full", account)
		}
		id, err := be.Upload(account, fmt.Sprintf("%d-%s.%05d.chunk", m.Created.Unix(), url.PathEscape(m.Name), idx), part)
		if err != nil {
			return chunk{}, err
		}
		free[account] -= int64(len(part))
		return chunk{idx, account, id, len(part), hashHex(part)}, nil
	}

	buf := make([]byte, k*chunkSize)
	piece := 0
	for s := 0; ; s++ {
		// accounts that can still take a whole shard, most free first.
		// A full account simply drops out; stripes get narrower, never fail
		// while 3 accounts still have room.
		var room []string
		for _, a := range accounts {
			if free[a] >= chunkSize {
				room = append(room, a)
			}
		}
		sort.SliceStable(room, func(i, j int) bool { return free[room[i]] > free[room[j]] })
		if len(room) < 3 {
			undo()
			return errors.New("fewer than 3 accounts have room left; add accounts or free some space")
		}
		width := len(room)
		got, rerr := io.ReadFull(src, buf[:(width-1)*chunkSize])
		if rerr != nil && rerr != io.EOF && rerr != io.ErrUnexpectedEOF {
			undo()
			return fmt.Errorf("reading %s: %w", m.Name, rerr)
		}
		if got == 0 && s > 0 {
			break
		}
		data := buf[:got]
		whole.Write(data)
		m.Size += int64(got)

		parityAcc := room[0]
		others := room[1:]
		k := len(others)

		// a short (last or small) stripe is split evenly, so every account
		// gets a fair share instead of one holding it all
		shardLen := chunkSize
		if len(data) < k*chunkSize {
			shardLen = (len(data) + k - 1) / k
		}
		parity := make([]byte, shardLen)
		maxLen := 0
		var st stripe
		fmt.Printf("  stripe %d: ", s+1)
		for i := 0; i < k; i++ {
			start := i * shardLen
			if start > len(data) {
				start = len(data)
			}
			end := start + shardLen
			if end > len(data) {
				end = len(data)
			}
			part := data[start:end]
			if len(part) > maxLen {
				maxLen = len(part)
			}
			xorInto(parity, part)
			c, err := upload(others[i], piece, part)
			piece++
			if err != nil {
				m.Stripes = append(m.Stripes, st)
				undo()
				return fmt.Errorf("stripe %d: %w", s+1, err)
			}
			st.Shards = append(st.Shards, c)
			fmt.Printf("%s ", others[i])
		}
		pc, err := upload(parityAcc, piece, parity[:maxLen])
		piece++
		if err != nil {
			m.Stripes = append(m.Stripes, st)
			undo()
			return fmt.Errorf("stripe %d parity: %w", s+1, err)
		}
		st.Parity = pc
		fmt.Printf("+ parity on %s\n", parityAcc)
		m.Stripes = append(m.Stripes, st)
		if rerr != nil {
			break
		}
	}
	return nil
}

// readParity writes the original bytes to w. Shards on accounts listed in
// lost, or that fail to download or verify, are rebuilt from parity.
// Returns the names of accounts it had to rebuild around.
func readParity(be backend, m manifest, w io.Writer, lost map[string]bool) ([]string, error) {
	rebuiltFrom := map[string]bool{}
	fetch := func(c chunk) ([]byte, error) {
		if lost[c.Account] {
			return nil, errors.New("marked as lost")
		}
		b, err := be.Download(c.Account, c.FileID)
		if err != nil {
			return nil, err
		}
		if hashHex(b) != c.SHA256 {
			return nil, errors.New("checksum mismatch")
		}
		return b, nil
	}
	for si, st := range m.Stripes {
		shards := make([][]byte, len(st.Shards))
		missing := -1
		for i, c := range st.Shards {
			b, err := fetch(c)
			if err != nil {
				if missing >= 0 {
					return nil, fmt.Errorf("stripe %d: two pieces are gone (%s and %s); 1 parity can rebuild only one",
						si+1, st.Shards[missing].Account, c.Account)
				}
				missing = i
				continue
			}
			shards[i] = b
		}
		if missing >= 0 {
			p, err := fetch(st.Parity)
			if err != nil {
				return nil, fmt.Errorf("stripe %d: piece on %s is gone and the parity on %s too",
					si+1, st.Shards[missing].Account, st.Parity.Account)
			}
			rebuilt := append([]byte(nil), p...)
			for i, b := range shards {
				if i != missing {
					xorInto(rebuilt, b)
				}
			}
			rebuilt = rebuilt[:st.Shards[missing].Size]
			if hashHex(rebuilt) != st.Shards[missing].SHA256 {
				return nil, fmt.Errorf("stripe %d: rebuilt piece does not match its checksum", si+1)
			}
			shards[missing] = rebuilt
			rebuiltFrom[st.Shards[missing].Account] = true
			fmt.Printf("  stripe %d/%d: rebuilt the piece from %s using parity\n", si+1, len(m.Stripes), st.Shards[missing].Account)
		} else {
			fmt.Printf("  stripe %d/%d ok\n", si+1, len(m.Stripes))
		}
		for _, b := range shards {
			if _, err := w.Write(b); err != nil {
				return nil, err
			}
		}
	}
	var out []string
	for a := range rebuiltFrom {
		out = append(out, a)
	}
	return out, nil
}

// usableWithParity says how much data fits when stored with parity, by
// playing the same placement rule forward in shard-sized steps.
func usableWithParity(free []int64) int64 {
	units := make([]int64, len(free))
	for i, f := range free {
		units[i] = f / chunkSize
	}
	var total int64
	for {
		var room []int
		for i, u := range units {
			if u > 0 {
				room = append(room, i)
			}
		}
		if len(room) < 3 {
			return total * chunkSize
		}
		sort.SliceStable(room, func(a, b int) bool { return units[room[a]] > units[room[b]] })
		// take as many full stripes as possible before the order can change
		steps := units[room[len(room)-1]]
		if steps > 64 {
			steps = 64
		}
		for _, i := range room {
			units[i] -= steps
		}
		total += steps * int64(len(room)-1)
	}
}
