package main

// Day 2: put a file into the pool and get it back.
//
// A file is cut into fixed-size chunks. Each chunk goes to the account with
// the most free space at that moment, inside a "havuz" folder. A small
// manifest (kept in ~/.havuz/files/) remembers where every chunk went and its
// SHA-256, so the file can be rebuilt and checked byte for byte.
//
// Day 3 adds a parity chunk to every stripe, so a lost account can be rebuilt.

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const chunkSize = 4 << 20 // 4 MiB: small enough for a simple one-request upload

// ---------- storage backend (interface so it can be tested without Google) ----------

type backend interface {
	Upload(account, name string, data []byte) (id string, err error)
	Download(account, id string) ([]byte, error)
	Delete(account, id string) error
	Free(account string) (int64, error)
}

// ---------- manifest ----------

type chunk struct {
	Index   int    `json:"index"`
	Account string `json:"account"`
	FileID  string `json:"file_id"`
	Size    int    `json:"size"`
	SHA256  string `json:"sha256"`
}

type manifest struct {
	Name    string    `json:"name"`
	Folder  bool      `json:"folder,omitempty"` // stored as a zip, unpacked on get
	Size    int64     `json:"size"`
	SHA256  string    `json:"sha256"`
	Created time.Time `json:"created"`
	Chunks  []chunk   `json:"chunks,omitempty"`  // plain chunks (fewer than 3 accounts)
	Stripes []stripe  `json:"stripes,omitempty"` // parity stripes (3+ accounts)
}

// pieces lists every stored piece of a file, data and parity.
func (m manifest) pieces() []chunk {
	out := append([]chunk(nil), m.Chunks...)
	for _, st := range m.Stripes {
		out = append(out, st.Shards...)
		out = append(out, st.Parity)
	}
	return out
}

func manifestDir() string { return filepath.Join(homeDir(), "files") }

func manifestPath(name string) string {
	return filepath.Join(manifestDir(), url.PathEscape(name)+".json")
}

func saveManifest(m manifest) error {
	if err := os.MkdirAll(manifestDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(m, "", "  ")
	return os.WriteFile(manifestPath(m.Name), b, 0o600)
}

func loadManifest(name string) (manifest, error) {
	var m manifest
	b, err := os.ReadFile(manifestPath(name))
	if err != nil {
		return m, fmt.Errorf("%q is not in the pool", name)
	}
	return m, json.Unmarshal(b, &m)
}

func allManifests() []manifest {
	files, _ := filepath.Glob(filepath.Join(manifestDir(), "*.json"))
	var out []manifest
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var m manifest
		if json.Unmarshal(b, &m) == nil {
			out = append(out, m)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func hashHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// ---------- put / get / rm ----------

// rebuildable lists folders that tools re-create on their own (npm install,
// pip install, a build). They are often most of a project's size, so folders
// are uploaded without them unless --all is given. .git is NOT skipped: it
// holds history that may exist nowhere else.
var rebuildable = map[string]bool{
	"node_modules": true, "__pycache__": true, ".venv": true, "venv": true,
	".next": true, ".nuxt": true, ".gradle": true, ".cache": true,
	".pytest_cache": true, ".mypy_cache": true, ".turbo": true, ".parcel-cache": true,
}

// includeAll turns off skipping of rebuildable folders (put --all).
var includeAll bool

func skipDir(fi os.FileInfo) bool { return !includeAll && fi.IsDir() && rebuildable[fi.Name()] }

// sourceFor opens a file, or packs a folder into a zip on the fly. Nothing is
// written to disk: the zip is produced in memory as the chunks are uploaded,
// so this works even when the disk is almost full.
func sourceFor(path string) (r io.ReadCloser, name string, sizeHint int64, isDir bool, err error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", 0, false, err
	}
	clean := filepath.Clean(path)
	name = filepath.Base(clean)
	if !info.IsDir() {
		f, err := os.Open(clean)
		return f, name, info.Size(), false, err
	}
	// total size of the folder, as an upper bound for the space check
	var skipped []string
	filepath.Walk(clean, func(p string, fi os.FileInfo, e error) error {
		if e != nil {
			return nil
		}
		if p != clean && skipDir(fi) {
			rel, _ := filepath.Rel(clean, p)
			skipped = append(skipped, filepath.ToSlash(rel))
			return filepath.SkipDir
		}
		if !fi.IsDir() {
			sizeHint += fi.Size()
		}
		return nil
	})
	if len(skipped) > 0 {
		fmt.Printf("  skipping %d rebuildable folder(s) (use --all to keep them): %s\n", len(skipped), strings.Join(skipped, ", "))
	}
	pr, pw := io.Pipe()
	go func() {
		zw := zip.NewWriter(pw)
		err := filepath.Walk(clean, func(p string, fi os.FileInfo, e error) error {
			if e != nil {
				return e
			}
			rel, _ := filepath.Rel(clean, p)
			if rel == "." {
				return nil
			}
			rel = filepath.ToSlash(rel)
			if skipDir(fi) {
				return filepath.SkipDir
			}
			if fi.IsDir() {
				_, err := zw.Create(rel + "/")
				return err
			}
			if !fi.Mode().IsRegular() {
				return nil // skip links, devices etc.
			}
			h, err := zip.FileInfoHeader(fi)
			if err != nil {
				return err
			}
			h.Name = rel
			h.Method = zip.Deflate
			w, err := zw.CreateHeader(h)
			if err != nil {
				return err
			}
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(w, f)
			return err
		})
		if err == nil {
			err = zw.Close()
		}
		pw.CloseWithError(err)
	}()
	return pr, name, sizeHint, true, nil
}

func putFile(be backend, accounts []string, path string) (manifest, error) {
	src, name, sizeHint, isDir, err := sourceFor(path)
	if err != nil {
		return manifest{}, err
	}
	defer src.Close()
	return putReader(be, accounts, src, name, sizeHint, isDir)
}

// putLock makes uploads (from the CLI or from several devices on the panel)
// go one after another, so they never fight over the same free space.
var putLock sync.Mutex

// putReader stores everything read from src under the given name.
func putReader(be backend, accounts []string, src io.Reader, name string, sizeHint int64, isDir bool) (manifest, error) {
	putLock.Lock()
	defer putLock.Unlock()
	var m manifest
	if len(accounts) == 0 {
		return m, errors.New("no accounts yet, add one with: havuz add <name>")
	}
	if name == "" || strings.ContainsAny(name, "/\\") || name == "." || name == ".." {
		return m, fmt.Errorf("bad file name %q", name)
	}
	if _, err := loadManifest(name); err == nil {
		return m, fmt.Errorf("%q is already in the pool (remove it first: havuz rm %s)", name, name)
	}

	// how much room each account has right now
	free := map[string]int64{}
	var total int64
	for _, a := range accounts {
		f, err := be.Free(a)
		if err != nil {
			return m, fmt.Errorf("account %s: %w", a, err)
		}
		free[a] = f
		total += f
	}
	if len(accounts) >= 3 {
		var fs []int64
		for _, a := range accounts {
			fs = append(fs, free[a])
		}
		if usable := usableWithParity(fs); sizeHint > usable {
			return m, fmt.Errorf("not enough space: %s is %s, the pool can hold %s with parity", name, gb(sizeHint), gb(usable))
		}
	} else if sizeHint > total {
		return m, fmt.Errorf("not enough space: %s is %s, pool has %s free", name, gb(sizeHint), gb(total))
	}

	m = manifest{Name: name, Folder: isDir, Created: time.Now()}
	whole := sha256.New()
	if len(accounts) >= 3 {
		fmt.Println("  parity on: survives losing any 1 account")
		if err := putParity(be, accounts, src, &m, free, whole); err != nil {
			return m, err
		}
		m.SHA256 = hex.EncodeToString(whole.Sum(nil))
		return m, saveManifest(m)
	}
	fmt.Println("  parity off: add at least 3 accounts to survive losing one")
	undo := func() {
		for _, c := range m.Chunks {
			be.Delete(c.Account, c.FileID)
		}
	}
	buf := make([]byte, chunkSize)
	for i := 0; ; i++ {
		n, rerr := io.ReadFull(src, buf)
		if rerr != nil && rerr != io.EOF && rerr != io.ErrUnexpectedEOF {
			undo()
			return m, fmt.Errorf("reading %s: %w", name, rerr)
		}
		if n == 0 && i > 0 {
			break
		}
		part := buf[:n]
		whole.Write(part)
		m.Size += int64(n)

		best := accounts[0] // the account with the most free space
		for _, a := range accounts {
			if free[a] > free[best] {
				best = a
			}
		}
		if free[best] < int64(n) {
			undo()
			return m, errors.New("ran out of space in the pool")
		}
		fmt.Printf("  chunk %d (%s) -> %s\n", i+1, gb(int64(n)), best)
		id, err := be.Upload(best, fmt.Sprintf("%d-%s.%04d.chunk", m.Created.Unix(), url.PathEscape(name), i), part)
		if err != nil {
			undo() // leave nothing half-uploaded behind
			return m, fmt.Errorf("upload of chunk %d failed: %w", i+1, err)
		}
		free[best] -= int64(n)
		m.Chunks = append(m.Chunks, chunk{i, best, id, n, hashHex(part)})
		if rerr != nil { // short read: that was the last chunk
			break
		}
	}
	m.SHA256 = hex.EncodeToString(whole.Sum(nil))
	return m, saveManifest(m)
}

// writeData streams a stored file's original bytes (for a folder: its zip)
// into w, checking every piece and rebuilding lost ones from parity.
func writeData(be backend, m manifest, w io.Writer, lost map[string]bool) error {
	if len(m.Stripes) > 0 {
		rebuilt, err := readParity(be, m, w, lost)
		if err != nil {
			return err
		}
		if len(rebuilt) > 0 {
			fmt.Printf("  recovered without: %s\n", strings.Join(rebuilt, ", "))
		}
	}
	for _, c := range m.Chunks {
		if lost[c.Account] {
			return fmt.Errorf("chunk %d is on %s and this file has no parity", c.Index+1, c.Account)
		}
		fmt.Printf("  chunk %d/%d <- %s\n", c.Index+1, len(m.Chunks), c.Account)
		b, err := be.Download(c.Account, c.FileID)
		if err != nil {
			return fmt.Errorf("chunk %d from %s: %w", c.Index+1, c.Account, err)
		}
		if hashHex(b) != c.SHA256 {
			return fmt.Errorf("chunk %d from %s is damaged (checksum mismatch)", c.Index+1, c.Account)
		}
		if _, err := w.Write(b); err != nil {
			return err
		}
	}
	return nil
}

// getFile streams the chunks straight into the output file, checking each one,
// so even a big file never has to fit in memory. A folder comes back as a
// folder (it is unpacked, and the temporary zip is removed).
func getFile(be backend, name, out string, lost map[string]bool) error {
	m, err := loadManifest(name)
	if err != nil {
		return err
	}
	if out == "" {
		out = filepath.Base(name)
	}
	if _, err := os.Stat(out); err == nil {
		return fmt.Errorf("%s already exists here, give another name: havuz get %s <new-name>", out, name)
	}
	target := out
	if m.Folder {
		target = out + ".havuz-tmp.zip"
	}
	f, err := os.Create(target)
	if err != nil {
		return err
	}
	whole := sha256.New()
	fail := func(e error) error { f.Close(); os.Remove(target); return e }
	if err := writeData(be, m, io.MultiWriter(f, whole), lost); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		return fail(err)
	}
	if hex.EncodeToString(whole.Sum(nil)) != m.SHA256 {
		os.Remove(target)
		return errors.New("rebuilt file does not match the original checksum")
	}
	if !m.Folder {
		return nil
	}
	defer os.Remove(target)
	return unzipTo(target, out)
}

func unzipTo(zipPath, dir string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	base, _ := filepath.Abs(dir)
	for _, zf := range zr.File {
		p := filepath.Join(base, filepath.FromSlash(zf.Name))
		if !strings.HasPrefix(p, base+string(os.PathSeparator)) && p != base {
			return fmt.Errorf("unsafe path in archive: %s", zf.Name)
		}
		if strings.HasSuffix(zf.Name, "/") {
			if err := os.MkdirAll(p, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		rc, err := zf.Open()
		if err != nil {
			return err
		}
		w, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, zf.Mode().Perm()|0o200)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		w.Close()
		if err != nil {
			return err
		}
		os.Chtimes(p, zf.Modified, zf.Modified)
	}
	return nil
}

func rmFile(be backend, name string) error {
	m, err := loadManifest(name)
	if err != nil {
		return err
	}
	for _, c := range m.pieces() {
		if err := be.Delete(c.Account, c.FileID); err != nil {
			return fmt.Errorf("could not delete chunk %d from %s: %w", c.Index+1, c.Account, err)
		}
	}
	return os.Remove(manifestPath(name))
}

func lsFiles() {
	ms := allManifests()
	if len(ms) == 0 {
		fmt.Println("The pool is empty. Add a file with: havuz put <file>")
		return
	}
	defer fmt.Println("(+P = parity: survives losing one account)")
	fmt.Printf("%-40s %-9s %12s %7s  %s\n", "NAME", "TYPE", "SIZE", "PIECES", "ACCOUNTS")
	for _, m := range ms {
		seen := map[string]bool{}
		var accs []string
		for _, c := range m.pieces() {
			if !seen[c.Account] {
				seen[c.Account] = true
				accs = append(accs, c.Account)
			}
		}
		kind := "file"
		if m.Folder {
			kind = "folder"
		}
		if len(m.Stripes) > 0 {
			kind += "+P"
		}
		fmt.Printf("%-40s %-9s %12s %7d  %s\n", m.Name, kind, human(m.Size), len(m.pieces()), strings.Join(accs, ", "))
	}
}

// ---------- Google Drive backend ----------

type drive struct {
	folders map[string]string // account -> id of its "havuz" folder
}

func newDrive() *drive { return &drive{folders: map[string]string{}} }

// do sends one request to Drive. Network errors, rate limits (429) and
// Google-side errors (5xx) are retried 3 times with growing waits.
func (d *drive) do(account, method, u string, body io.Reader, contentType string) ([]byte, error) {
	var payload []byte
	if body != nil {
		payload, _ = io.ReadAll(body)
	}
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			wait := time.Duration(attempt*attempt*2) * time.Second
			fmt.Printf("    retrying in %s (%v)\n", wait, lastErr)
			time.Sleep(wait)
		}
		tok, err := validToken(account)
		if err != nil {
			lastErr = err
			continue
		}
		var rd io.Reader
		if payload != nil {
			rd = bytes.NewReader(payload)
		}
		req, _ := http.NewRequest(method, u, rd)
		req.Header.Set("Authorization", "Bearer "+tok)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == 429 || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("Drive said HTTP %d", resp.StatusCode)
			continue
		}
		if resp.StatusCode >= 300 {
			return nil, fmt.Errorf("Drive said HTTP %d: %s", resp.StatusCode, b)
		}
		return b, nil
	}
	return nil, lastErr
}

// folder finds (or makes) the "havuz" folder in this account.
func (d *drive) folder(account string) (string, error) {
	if id, ok := d.folders[account]; ok {
		return id, nil
	}
	q := url.QueryEscape("name='havuz' and mimeType='application/vnd.google-apps.folder' and trashed=false")
	b, err := d.do(account, "GET", "https://www.googleapis.com/drive/v3/files?fields=files(id)&q="+q, nil, "")
	if err != nil {
		return "", err
	}
	var r struct {
		Files []struct {
			ID string `json:"id"`
		} `json:"files"`
	}
	json.Unmarshal(b, &r)
	if len(r.Files) > 0 {
		d.folders[account] = r.Files[0].ID
		return r.Files[0].ID, nil
	}
	meta := `{"name":"havuz","mimeType":"application/vnd.google-apps.folder"}`
	b, err = d.do(account, "POST", "https://www.googleapis.com/drive/v3/files?fields=id", strings.NewReader(meta), "application/json")
	if err != nil {
		return "", err
	}
	var f struct {
		ID string `json:"id"`
	}
	json.Unmarshal(b, &f)
	d.folders[account] = f.ID
	return f.ID, nil
}

func (d *drive) Upload(account, name string, data []byte) (string, error) {
	parent, err := d.folder(account)
	if err != nil {
		return "", err
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	h := textproto.MIMEHeader{}
	h.Set("Content-Type", "application/json; charset=UTF-8")
	p, _ := w.CreatePart(h)
	json.NewEncoder(p).Encode(map[string]any{"name": name, "parents": []string{parent}})
	h = textproto.MIMEHeader{}
	h.Set("Content-Type", "application/octet-stream")
	p, _ = w.CreatePart(h)
	p.Write(data)
	w.Close()

	b, err := d.do(account, "POST",
		"https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
		&body, "multipart/related; boundary="+w.Boundary())
	if err != nil {
		return "", err
	}
	var f struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &f); err != nil || f.ID == "" {
		return "", fmt.Errorf("unexpected answer from Drive: %s", b)
	}
	return f.ID, nil
}

func (d *drive) Download(account, id string) ([]byte, error) {
	return d.do(account, "GET", "https://www.googleapis.com/drive/v3/files/"+id+"?alt=media", nil, "")
}

func (d *drive) Delete(account, id string) error {
	_, err := d.do(account, "DELETE", "https://www.googleapis.com/drive/v3/files/"+id, nil, "")
	return err
}

func (d *drive) Free(account string) (int64, error) {
	q, err := getQuota(account)
	if err != nil {
		return 0, err
	}
	return q.Limit - q.Usage, nil
}
