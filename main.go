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

func addAccount(name string) error {
	c, err := loadClient()
	if err != nil {
		return err
	}
	var dc struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURL string `json:"verification_url"`
		Interval        int    `json:"interval"`
		ExpiresIn       int    `json:"expires_in"`
	}
	if err := postForm(deviceCodeURL, url.Values{
		"client_id": {c.ClientID},
		"scope":     {scope},
	}, &dc); err != nil {
		return fmt.Errorf("could not start login: %w", err)
	}

	fmt.Println()
	fmt.Println("  On your phone (or any device), open:  ", dc.VerificationURL)
	fmt.Println("  and type this code:                   ", dc.UserCode)
	fmt.Println()
	fmt.Println("  Waiting for you to approve...")

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
			t := token{tr.AccessToken, tr.RefreshToken, time.Now().Add(time.Duration(tr.ExpiresIn) * time.Second)}
			if err := saveToken(name, t); err != nil {
				return err
			}
			fmt.Printf("  Connected. Account saved as %q.\n", name)
			return nil
		case err.Error() == "authorization_pending":
			// user has not approved yet, keep waiting
		case err.Error() == "slow_down":
			interval += 5 * time.Second
		default:
			return fmt.Errorf("login failed: %w", err)
		}
	}
	return errors.New("code expired, run the command again")
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

func listAccounts() error {
	names := accountNames()
	if len(names) == 0 {
		fmt.Println("No accounts yet. Add one with: havuz add <name>")
		return nil
	}
	var totalFree int64
	fmt.Printf("%-12s %-32s %12s %12s\n", "NAME", "EMAIL", "USED", "FREE")
	for _, n := range names {
		q, err := getQuota(n)
		if err != nil {
			fmt.Printf("%-12s ERROR: %v\n", n, err)
			continue
		}
		free := q.Limit - q.Usage
		totalFree += free
		fmt.Printf("%-12s %-32s %12s %12s\n", n, q.Email, gb(q.Usage), gb(free))
	}
	fmt.Println()
	fmt.Printf("Total free space: %s across %d accounts\n", gb(totalFree), len(names))
	if len(names) >= 3 {
		// preview of day-N feature: one account worth of space goes to parity
		fmt.Printf("With 1 parity account (survives losing any 1 account): about %s usable\n",
			gb(totalFree*int64(len(names)-1)/int64(len(names))))
	}
	return nil
}

// ---------- setup ----------

func setup() error {
	var c clientConfig
	fmt.Print("Paste your Google OAuth Client ID: ")
	fmt.Scanln(&c.ClientID)
	fmt.Print("Paste your Client Secret: ")
	fmt.Scanln(&c.ClientSecret)
	if c.ClientID == "" || c.ClientSecret == "" {
		return errors.New("both values are needed")
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

func usage() {
	fmt.Println(`havuz - one big storage pool from many cloud accounts

Commands:
  havuz setup        save your Google OAuth client (once)
  havuz add <name>   connect a Google Drive account
  havuz list         show every account and the total free space`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}
	var err error
	switch os.Args[1] {
	case "setup":
		err = setup()
	case "add":
		if len(os.Args) < 3 {
			err = errors.New("give the account a name, e.g. havuz add main")
		} else {
			err = addAccount(os.Args[2])
		}
	case "list":
		err = listAccounts()
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Error:", err)
		os.Exit(1)
	}
}
