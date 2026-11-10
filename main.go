// havuz: pool many free cloud accounts into one storage, with parity so
// losing an account does not lose your files.
//
// Day 1: connect Google Drive accounts (device-code login, keyboard only)
// and show how much space each one has.
//
// Uses only the Go standard library. No external packages.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	deviceCodeURL = "https://oauth2.googleapis.com/device/code"
	tokenURL      = "https://oauth2.googleapis.com/token"
	aboutURL      = "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota"
	// drive.file: the app only sees files it created itself. That is all a
	// storage pool needs, and Google allows it with the device-code login.
	scope = "https://www.googleapis.com/auth/drive.file"
)

// ---------- config & storage on disk ----------

type clientConfig struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
}

type token struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	Expiry       time.Time `json:"expiry"`
}

func homeDir() string {
	d, err := os.UserHomeDir()
	if err != nil {
		d = "."
	}
	return filepath.Join(d, ".havuz")
}

func loadClient() (clientConfig, error) {
	var c clientConfig
	b, err := os.ReadFile(filepath.Join(homeDir(), "client.json"))
	if err != nil {
		return c, fmt.Errorf("client.json not found in %s (run: havuz setup)", homeDir())
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("client.json is broken: %w", err)
	}
	return c, nil
}

func tokenPath(name string) string {
	return filepath.Join(homeDir(), "accounts", name+".json")
}

func saveToken(name string, t token) error {
	if err := os.MkdirAll(filepath.Dir(tokenPath(name)), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(t, "", "  ")
	return os.WriteFile(tokenPath(name), b, 0o600)
}

func loadToken(name string) (token, error) {
	var t token
	b, err := os.ReadFile(tokenPath(name))
	if err != nil {
		return t, err
	}
	return t, json.Unmarshal(b, &t)
}

func accountNames() []string {
	files, _ := filepath.Glob(filepath.Join(homeDir(), "accounts", "*.json"))
	var names []string
	for _, f := range files {
		names = append(names, strings.TrimSuffix(filepath.Base(f), ".json"))
	}
	sort.Strings(names)
	return names
}

// ---------- Google OAuth (device code flow) ----------

func postForm(u string, v url.Values, out any) error {
	resp, err := http.PostForm(u, v)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(body, &e)
		if e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, body)
	}
	return json.Unmarshal(body, out)
}

type deviceCode struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURL string `json:"verification_url"`
	Interval        int    `json:"interval"`
	ExpiresIn       int    `json:"expires_in"`
}

// addAccounts connects one account (called with a single name).
func addAccounts(names []string) error {
	c, err := loadClient()
	if err != nil {
		return err
	}
	codes := make([]deviceCode, len(names))
	for i, n := range names {
		if err := postForm(deviceCodeURL, url.Values{
			"client_id": {c.ClientID},
			"scope":     {scope},
		}, &codes[i]); err != nil {
			return fmt.Errorf("could not start login for %s: %w", n, err)
		}
	}

	fmt.Println()
	fmt.Println("  Open", codes[0].VerificationURL, "and type the code, signed in as the right account:")
	fmt.Println()
	for i, n := range names {
		fmt.Printf("    %-12s %s\n", n, codes[i].UserCode)
	}
	fmt.Println()
	fmt.Printf("  Codes work for about %d minutes. Waiting...\n\n", codes[0].ExpiresIn/60)

	type result struct {
		name string
		err  error
	}
	done := make(chan result)
	for i, n := range names {
		go func(n string, dc deviceCode) { done <- result{n, waitDevice(c, n, dc)} }(n, codes[i])
	}
	var failed []string
	for range names {
		r := <-done
		if r.err != nil {
			fmt.Printf("  %-12s FAILED: %v\n", r.name, r.err)
			failed = append(failed, r.name)
		} else {
			fmt.Printf("  %-12s connected\n", r.name)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("not connected: %s (run: havuz add %s)", strings.Join(failed, ", "), strings.Join(failed, " "))
	}
	return nil
}

func waitDevice(c clientConfig, name string, dc deviceCode) error {
	interval := time.Duration(dc.Interval) * time.Second
	if interval == 0 {
		interval = 5 * time.Second
	}
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(interval)
		var tr struct {
			AccessToken  string `json:"access_token"`
			RefreshToken string `json:"refresh_token"`
			ExpiresIn    int    `json:"expires_in"`
		}
		err := postForm(tokenURL, url.Values{
			"client_id":     {c.ClientID},
			"client_secret": {c.ClientSecret},
			"device_code":   {dc.DeviceCode},
			"grant_type":    {"urn:ietf:params:oauth:grant-type:device_code"},
		}, &tr)
		switch {
		case err == nil:
			return saveToken(name, token{tr.AccessToken, tr.RefreshToken, time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)})
		case err.Error() == "authorization_pending":
		case err.Error() == "slow_down":
			interval += 5 * time.Second
		default:
			return err
		}
	}
	return errors.New("code expired")
}

// validToken returns a working access token, refreshing it if it expired.
func validToken(name string) (string, error) {
	t, err := loadToken(name)
	if err != nil {
		return "", err
	}
	if time.Now().Before(t.Expiry.Add(-time.Minute)) {
		return t.AccessToken, nil
	}
	c, err := loadClient()
	if err != nil {
		return "", err
	}
	var tr struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := postForm(tokenURL, url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"refresh_token": {t.RefreshToken},
		"grant_type":    {"refresh_token"},
	}, &tr); err != nil {
		return "", fmt.Errorf("refresh failed (try: havuz add %s): %w", name, err)
	}
	t.AccessToken = tr.AccessToken
	t.Expiry = time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)
	return t.AccessToken, saveToken(name, t)
}

// ---------- Drive: how much space? ----------

type quota struct {
	Email string
	Limit int64 // bytes, 0 = unlimited
	Usage int64
}

func getQuota(name string) (quota, error) {
	var q quota
	tok, err := validToken(name)
	if err != nil {
		return q, err
	}
	req, _ := http.NewRequest("GET", aboutURL, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return q, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return q, fmt.Errorf("Drive said HTTP %d: %s", resp.StatusCode, body)
	}
	var a struct {
		User struct {
			EmailAddress string `json:"emailAddress"`
		} `json:"user"`
		StorageQuota struct {
			Limit string `json:"limit"`
			Usage string `json:"usage"`
		} `json:"storageQuota"`
	}
	if err := json.Unmarshal(body, &a); err != nil {
		return q, err
	}
	q.Email = a.User.EmailAddress
	q.Limit, _ = strconv.ParseInt(a.StorageQuota.Limit, 10, 64)
	q.Usage, _ = strconv.ParseInt(a.StorageQuota.Usage, 10, 64)
	return q, nil
}

func gb(b int64) string { return fmt.Sprintf("%.2f GB", float64(b)/1e9) }

// human prints a size in the unit that reads best.
func human(b int64) string {
	switch {
	case b >= 1e9:
		return fmt.Sprintf("%.2f GB", float64(b)/1e9)
	case b >= 1e6:
		return fmt.Sprintf("%.1f MB", float64(b)/1e6)
	case b >= 1e3:
		return fmt.Sprintf("%.0f KB", float64(b)/1e3)
	}
	return fmt.Sprintf("%d bytes", b)
}

func listAccounts() error {
	names := accountNames()
	if len(names) == 0 {
		fmt.Println("No accounts yet. Add one with: havuz add <name>")
		return nil
	}
	var totalFree int64
	var frees []int64
	fmt.Printf("%-12s %-32s %12s %12s\n", "NAME", "EMAIL", "USED", "FREE")
	for _, n := range names {
		q, err := getQuota(n)
		if err != nil {
			fmt.Printf("%-12s ERROR: %v\n", n, err)
			continue
		}
		free := q.Limit - q.Usage
		totalFree += free
		frees = append(frees, free)
		fmt.Printf("%-12s %-32s %12s %12s\n", n, q.Email, gb(q.Usage), gb(free))
	}
	fmt.Println()
	fmt.Printf("Total free space: %s across %d accounts\n", gb(totalFree), len(names))
	if len(frees) >= 3 {
		fmt.Printf("With parity (survives losing any 1 account): about %s usable\n", gb(usableWithParity(frees)))
	}
	return nil
}

// ---------- setup ----------

// setupFromFile reads the JSON file Google Cloud lets you download for a
// client ({"installed": {...}} or {"web": {...}}), so nothing has to be typed.
func setupFromFile(path string) (clientConfig, error) {
	var c clientConfig
	b, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	var wrapped map[string]clientConfig
	if json.Unmarshal(b, &wrapped) == nil {
		for _, v := range wrapped {
			if v.ClientID != "" {
				return v, nil
			}
		}
	}
	if json.Unmarshal(b, &c) == nil && c.ClientID != "" {
		return c, nil
	}
	return c, errors.New("no client_id found in that file")
}

func setup(args []string) error {
	var c clientConfig
	if len(args) > 0 {
		var err error
		if c, err = setupFromFile(args[0]); err != nil {
			return err
		}
		return saveClient(c)
	}
	fmt.Print("Paste your Google OAuth Client ID: ")
	fmt.Scanln(&c.ClientID)
	fmt.Print("Paste your Client Secret: ")
	fmt.Scanln(&c.ClientSecret)
	if c.ClientID == "" || c.ClientSecret == "" {
		return errors.New("both values are needed")
	}
	return saveClient(c)
}

func saveClient(c clientConfig) error {
	if c.ClientID == "" || c.ClientSecret == "" {
		return errors.New("client id and secret are both needed")
	}
	if err := os.MkdirAll(homeDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	if err := os.WriteFile(filepath.Join(homeDir(), "client.json"), b, 0o600); err != nil {
		return err
	}
	fmt.Println("Saved. Now run: havuz add <name>   (e.g. havuz add main)")
	return nil
}

func outName(args []string) string {
	for i := 3; i < len(args); i++ {
		if args[i] == "--without" {
			i++
			continue
		}
		return args[i]
	}
	return args[2]
}

func usage() {
	fmt.Println(`havuz - one big storage pool from many cloud accounts

Commands:
  havuz setup [file] save your Google OAuth client (once); give the
                     downloaded client_secret_....json to skip typing
  havuz add <name>   connect a Google Drive account
  havuz list         show every account and the total free space
  havuz put <path> [--all]
                     store a file or a whole folder; folders skip node_modules,
                     venv, __pycache__ and similar unless --all
  havuz ls           show the files in the pool
  havuz get <name> [out] [--without <account>]
                     rebuild and check the file; --without pretends that
                     account is gone, to prove parity can rebuild it
  havuz rm <name>    delete a file's chunks from every account`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}
	var err error
	switch os.Args[1] {
	case "setup":
		err = setup(os.Args[2:])
	case "add":
		if len(os.Args) != 3 {
			err = errors.New("give one account name, e.g. havuz add main")
		} else {
			err = addAccounts(os.Args[2:3])
		}
	case "list":
		err = listAccounts()
	case "put":
		args := os.Args[:2]
		for _, a := range os.Args[2:] {
			if a == "--all" {
				includeAll = true
			} else {
				args = append(args, a)
			}
		}
		os.Args = args
		if len(os.Args) < 3 {
			err = errors.New("which file? e.g. havuz put photo.jpg")
		} else {
			var m manifest
			if m, err = putFile(newDrive(), accountNames(), os.Args[2]); err == nil {
				fmt.Printf("Stored %q (%s) in %d pieces.\n", m.Name, human(m.Size), len(m.pieces()))
			}
		}
	case "get":
		if len(os.Args) < 3 {
			err = errors.New("which file? e.g. havuz get photo.jpg")
		} else {
			out := ""
			lost := map[string]bool{}
			for i := 3; i < len(os.Args); i++ {
				if os.Args[i] == "--without" && i+1 < len(os.Args) {
					lost[os.Args[i+1]] = true // pretend this account is gone
					i++
				} else if out == "" {
					out = os.Args[i]
				}
			}
			if err = getFile(newDrive(), os.Args[2], out, lost); err == nil {
				fmt.Println("Rebuilt and checked: every byte matches the original. Saved here as", outName(os.Args))
			}
		}
	case "ls":
		lsFiles()
	case "rm":
		if len(os.Args) < 3 {
			err = errors.New("which file? e.g. havuz rm photo.jpg")
		} else if err = rmFile(newDrive(), os.Args[2]); err == nil {
			fmt.Println("Removed from the pool.")
		}
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
