package main

import (
	"bytes"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// fake keeps "uploaded" chunks in memory instead of Google Drive.
type fake struct {
	files map[string][]byte
	free  map[string]int64
	n     int
	fail  int // fail the upload with this number (0 = never)
}

func newFake(accounts map[string]int64) *fake {
	return &fake{files: map[string][]byte{}, free: accounts}
}

func (f *fake) Upload(account, name string, data []byte) (string, error) {
	f.n++
	if f.n == f.fail {
		return "", errors.New("simulated network error")
	}
	id := fmt.Sprintf("%s/%d", account, f.n)
	f.files[id] = append([]byte(nil), data...)
	f.free[account] -= int64(len(data))
	return id, nil
}
func (f *fake) Download(account, id string) ([]byte, error) {
	b, ok := f.files[id]
	if !ok {
		return nil, errors.New("not found")
	}
	return b, nil
}
func (f *fake) Delete(account, id string) error    { delete(f.files, id); return nil }
func (f *fake) Free(account string) (int64, error) { return f.free[account], nil }

func setupHome(t *testing.T) string {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("USERPROFILE", dir)
	return dir
}

func writeRandom(t *testing.T, dir string, size int) (string, []byte) {
	data := make([]byte, size)
	rand.Read(data)
	p := filepath.Join(dir, "input.bin")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

func TestPutGetRoundTrip(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 100 << 20, "b": 100 << 20, "c": 100 << 20})
	path, data := writeRandom(t, dir, 3*chunkSize+12345) // 4 chunks, last one partial

	m, err := putFile(be, []string{"a", "b", "c"}, path)
	if err != nil {
		t.Fatal(err)
	}
	// 3 accounts: parity on, 2 data shards + 1 parity per stripe
	if len(m.Stripes) != 2 || len(m.Chunks) != 0 {
		t.Fatalf("want 2 parity stripes, got %d stripes / %d chunks", len(m.Stripes), len(m.Chunks))
	}
	used := map[string]bool{}
	for _, c := range m.pieces() {
		used[c.Account] = true
	}
	if len(used) != 3 {
		t.Fatalf("chunks should spread over all 3 accounts, used %v", used)
	}

	out := filepath.Join(dir, "out.bin")
	if err := getFile(be, "input.bin", out, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	if !bytes.Equal(got, data) {
		t.Fatal("rebuilt file differs from the original")
	}
}

func TestDamagedChunkIsCaught(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 100 << 20})
	path, _ := writeRandom(t, dir, chunkSize+10)
	m, err := putFile(be, []string{"a"}, path)
	if err != nil {
		t.Fatal(err)
	}
	be.files[m.Chunks[0].FileID][0] ^= 0xFF // flip some bits
	if err := getFile(be, "input.bin", filepath.Join(dir, "out.bin"), nil); err == nil {
		t.Fatal("damaged chunk was not detected")
	}
}

func TestFailedUploadLeavesNothingBehind(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 100 << 20})
	be.fail = 3
	path, _ := writeRandom(t, dir, 4*chunkSize)
	if _, err := putFile(be, []string{"a"}, path); err == nil {
		t.Fatal("expected an error")
	}
	if len(be.files) != 0 {
		t.Fatalf("%d chunks left behind after a failed upload", len(be.files))
	}
	if _, err := loadManifest("input.bin"); err == nil {
		t.Fatal("manifest saved for a failed upload")
	}
}

func TestNotEnoughSpace(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 1000})
	path, _ := writeRandom(t, dir, 5000)
	if _, err := putFile(be, []string{"a"}, path); err == nil {
		t.Fatal("expected not-enough-space error")
	}
}

func TestFolderRoundTrip(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 100 << 20, "b": 100 << 20})
	proj := filepath.Join(dir, "myproject")
	files := map[string][]byte{
		"main.go":            []byte("package main\nfunc main(){}\n"),
		"src/util/helper.go": []byte("package util\n"),
		"assets/big.bin":     make([]byte, 2*chunkSize+77),
	}
	rand.Read(files["assets/big.bin"])
	for rel, b := range files {
		p := filepath.Join(proj, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, b, 0o644)
	}
	os.MkdirAll(filepath.Join(proj, "empty"), 0o755)

	m, err := putFile(be, []string{"a", "b"}, proj)
	if err != nil {
		t.Fatal(err)
	}
	if !m.Folder || m.Name != "myproject" {
		t.Fatalf("bad manifest: %+v", m)
	}
	out := filepath.Join(dir, "restored")
	if err := getFile(be, "myproject", out, nil); err != nil {
		t.Fatal(err)
	}
	for rel, want := range files {
		got, err := os.ReadFile(filepath.Join(out, filepath.FromSlash(rel)))
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("%s did not come back intact", rel)
		}
	}
	if fi, err := os.Stat(filepath.Join(out, "empty")); err != nil || !fi.IsDir() {
		t.Fatal("empty folder lost")
	}
	if _, err := os.Stat(out + ".havuz-tmp.zip"); err == nil {
		t.Fatal("temporary zip left behind")
	}
}

func TestRemove(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 100 << 20})
	path, _ := writeRandom(t, dir, 2*chunkSize)
	if _, err := putFile(be, []string{"a"}, path); err != nil {
		t.Fatal(err)
	}
	if err := rmFile(be, "input.bin"); err != nil {
		t.Fatal(err)
	}
	if len(be.files) != 0 {
		t.Fatal("chunks not deleted")
	}
}

func putParityFile(t *testing.T, accounts []string, size int) (string, *fake, []byte) {
	dir := setupHome(t)
	free := map[string]int64{}
	for _, a := range accounts {
		free[a] = 500 << 20
	}
	be := newFake(free)
	path, data := writeRandom(t, dir, size)
	if _, err := putFile(be, accounts, path); err != nil {
		t.Fatal(err)
	}
	return dir, be, data
}

func TestParitySurvivesLosingAnyOneAccount(t *testing.T) {
	accounts := []string{"a", "b", "c", "d", "e"}
	for _, lost := range accounts {
		dir, be, data := putParityFile(t, accounts, 9*chunkSize+999)
		out := filepath.Join(dir, "out-"+lost)
		if err := getFile(be, "input.bin", out, map[string]bool{lost: true}); err != nil {
			t.Fatalf("losing %s: %v", lost, err)
		}
		got, _ := os.ReadFile(out)
		if !bytes.Equal(got, data) {
			t.Fatalf("losing %s: rebuilt file differs", lost)
		}
	}
}

func TestParityRebuildsAfterRealDeletion(t *testing.T) {
	dir, be, data := putParityFile(t, []string{"a", "b", "c"}, 5*chunkSize+1)
	for id := range be.files { // account "b" really disappears
		if id[:2] == "b/" {
			delete(be.files, id)
		}
	}
	out := filepath.Join(dir, "out.bin")
	if err := getFile(be, "input.bin", out, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	if !bytes.Equal(got, data) {
		t.Fatal("rebuilt file differs")
	}
}

func TestParityFixesCorruptedShard(t *testing.T) {
	dir, be, data := putParityFile(t, []string{"a", "b", "c", "d"}, 4*chunkSize)
	m, _ := loadManifest("input.bin")
	be.files[m.Stripes[0].Shards[1].FileID][100] ^= 0x55
	out := filepath.Join(dir, "out.bin")
	if err := getFile(be, "input.bin", out, nil); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	if !bytes.Equal(got, data) {
		t.Fatal("corruption was not repaired")
	}
}

func TestParityCannotSurviveTwoLosses(t *testing.T) {
	dir, be, _ := putParityFile(t, []string{"a", "b", "c", "d"}, 7*chunkSize)
	err := getFile(be, "input.bin", filepath.Join(dir, "out.bin"), map[string]bool{"a": true, "b": true})
	if err == nil {
		t.Fatal("two lost accounts should not be recoverable with one parity")
	}
	if _, serr := os.Stat(filepath.Join(dir, "out.bin")); serr == nil {
		t.Fatal("partial output left behind")
	}
}

func TestParitySmallAndEmptyFiles(t *testing.T) {
	for _, size := range []int{0, 1, 100, chunkSize, 3*chunkSize - 1} {
		dir, be, data := putParityFile(t, []string{"a", "b", "c"}, size)
		out := filepath.Join(dir, "out.bin")
		if err := getFile(be, "input.bin", out, map[string]bool{"c": true}); err != nil {
			t.Fatalf("size %d: %v", size, err)
		}
		got, _ := os.ReadFile(out)
		if !bytes.Equal(got, data) {
			t.Fatalf("size %d: differs", size)
		}
	}
}

func TestParityRemoveDeletesEverything(t *testing.T) {
	_, be, _ := putParityFile(t, []string{"a", "b", "c"}, 6*chunkSize)
	if err := rmFile(be, "input.bin"); err != nil {
		t.Fatal(err)
	}
	if len(be.files) != 0 {
		t.Fatalf("%d pieces left after rm", len(be.files))
	}
}

func TestParityFailedUploadLeavesNothing(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 500 << 20, "b": 500 << 20, "c": 500 << 20})
	be.fail = 5
	path, _ := writeRandom(t, dir, 8*chunkSize)
	if _, err := putFile(be, []string{"a", "b", "c"}, path); err == nil {
		t.Fatal("expected error")
	}
	if len(be.files) != 0 {
		t.Fatalf("%d pieces left behind", len(be.files))
	}
}

func TestParityUsesUnevenAccounts(t *testing.T) {
	// one nearly full account must not cap the whole pool
	dir := setupHome(t)
	be := newFake(map[string]int64{"small": 2 * chunkSize, "b": 60 * chunkSize, "c": 60 * chunkSize, "d": 60 * chunkSize})
	path, data := writeRandom(t, dir, 40*chunkSize) // far more than small*3
	if _, err := putFile(be, []string{"small", "b", "c", "d"}, path); err != nil {
		t.Fatal(err)
	}
	for _, lost := range []string{"small", "b", "c", "d"} {
		out := filepath.Join(dir, "out-"+lost)
		if err := getFile(be, "input.bin", out, map[string]bool{lost: true}); err != nil {
			t.Fatalf("losing %s: %v", lost, err)
		}
		got, _ := os.ReadFile(out)
		if !bytes.Equal(got, data) {
			t.Fatalf("losing %s: differs", lost)
		}
	}
}

func TestUsableEstimate(t *testing.T) {
	c := int64(chunkSize)
	if got := usableWithParity([]int64{10 * c, 10 * c, 10 * c}); got != 20*c {
		t.Fatalf("3 equal accounts: want %d got %d", 20*c, got)
	}
	if got := usableWithParity([]int64{1 * c, 40 * c, 40 * c, 40 * c}); got < 79*c {
		t.Fatalf("small account should not cap the pool, got %d chunks", got/c)
	}
	if got := usableWithParity([]int64{40 * c, 40 * c}); got != 0 {
		t.Fatal("2 accounts cannot hold parity data")
	}
}

func TestSmallFileIsSpreadEvenly(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 500 << 20, "b": 500 << 20, "c": 500 << 20, "d": 500 << 20})
	path, data := writeRandom(t, dir, 300000) // much smaller than one chunk
	m, err := putFile(be, []string{"a", "b", "c", "d"}, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range m.Stripes[0].Shards {
		if c.Size < 99000 {
			t.Fatalf("shard on %s holds only %d bytes; data should be split evenly", c.Account, c.Size)
		}
	}
	// losing the account that holds the first third must still work
	out := filepath.Join(dir, "out.bin")
	if err := getFile(be, "input.bin", out, map[string]bool{m.Stripes[0].Shards[0].Account: true}); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(out)
	if !bytes.Equal(got, data) {
		t.Fatal("differs")
	}
}

func TestFolderSkipsRebuildable(t *testing.T) {
	dir := setupHome(t)
	be := newFake(map[string]int64{"a": 500 << 20, "b": 500 << 20, "c": 500 << 20})
	proj := filepath.Join(dir, "web")
	for rel, body := range map[string]string{
		"index.js": "x", "node_modules/react/index.js": "big", ".git/HEAD": "ref", "src/venv/lib.py": "y",
	} {
		p := filepath.Join(proj, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	if _, err := putFile(be, []string{"a", "b", "c"}, proj); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "back")
	if err := getFile(be, "web", out, nil); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"index.js", ".git/HEAD"} {
		if _, err := os.Stat(filepath.Join(out, want)); err != nil {
			t.Fatalf("%s should be kept", want)
		}
	}
	for _, gone := range []string{"node_modules", "src/venv"} {
		if _, err := os.Stat(filepath.Join(out, gone)); err == nil {
			t.Fatalf("%s should be skipped", gone)
		}
	}
}
