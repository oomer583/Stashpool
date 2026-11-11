/**
 * havuz — Uygulama Mantığı (app.js)
 * Sadece saf JavaScript (ES modülleri).
 */

// ============================================================
// API SEÇİMİ:
// Önizleme için './mock-api.js', yayında './havuz-api.js' kullanılır.
// Tek satırla geçiş yapılabilir:
// ============================================================
// import { havuz, human } from './mock-api.js';
import { havuz, human } from './havuz-api.js';

// ============================================================
// SVG Simgeler (Satır İçi SVG Tanımları)
// ============================================================
const ICONS = {
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect width="14" height="14" x="1" y="5" rx="2" ry="2"></rect></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><line x1="10" y1="9" x2="8" y2="9"></line></svg>`,
  archive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`
};

// ============================================================
// Durum Değişkenleri (State)
// ============================================================
let currentScreen = 'welcome';
let activeUserEmail = '';
let currentFileToDelete = null;
let addAccountAbortController = null;
let currentSearchTerm = '';
let isUploading = false;
const uploadQueue = [];

// ============================================================
// DOM Element Referansları
// ============================================================
const screens = {
  welcome: document.getElementById('screen-welcome'),
  create: document.getElementById('screen-create'),
  recovery: document.getElementById('screen-recovery'),
  unlock: document.getElementById('screen-unlock'),
  forgot: document.getElementById('screen-forgot'),
  dashboard: document.getElementById('screen-dashboard')
};

const userPill = document.getElementById('user-pill');
const headerUserEmail = document.getElementById('header-user-email');
const headerUserAvatar = document.getElementById('header-user-avatar');
const lockPoolBtn = document.getElementById('lock-pool-btn');
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const themeSunIcon = document.getElementById('theme-sun-icon');
const themeMoonIcon = document.getElementById('theme-moon-icon');

// Bildirim Alanı
const toastContainer = document.getElementById('toast-container');

// Modallar
const modalAddAccount = document.getElementById('modal-add-account');
const modalDeleteConfirm = document.getElementById('modal-delete-confirm');

// ============================================================
// Bildirim (Toast) Sistemi
// ============================================================
function showToast(message, type = 'info', duration = 4000) {
  if (!toastContainer) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const iconWrap = document.createElement('div');
  iconWrap.className = 'toast-icon';
  if (type === 'success') {
    iconWrap.innerHTML = ICONS.check;
  } else if (type === 'error') {
    iconWrap.innerHTML = ICONS.alert;
  } else {
    iconWrap.innerHTML = ICONS.shield;
  }

  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'toast-close-btn';
  closeBtn.setAttribute('aria-label', 'Bildirimi kapat');
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

  closeBtn.addEventListener('click', () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 200);
  });

  toast.appendChild(iconWrap);
  toast.appendChild(msgSpan);
  toast.appendChild(closeBtn);
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      if (toast.isConnected) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        setTimeout(() => toast.remove(), 200);
      }
    }, duration);
  }
}

// ============================================================
// Ekran Geçişleri (Screen Router)
// ============================================================
function navigateTo(screenName) {
  currentScreen = screenName;

  Object.entries(screens).forEach(([name, el]) => {
    if (el) {
      if (name === screenName) {
        el.classList.remove('hidden');
      } else {
        el.classList.add('hidden');
      }
    }
  });

  // Üst çubuk durumunu güncelle
  if (screenName === 'dashboard') {
    userPill.classList.remove('hidden');
    lockPoolBtn.classList.remove('hidden');
    const status = havuz.status();
    updateUserBadge(status.email);
    renderDashboard(status);
  } else {
    if (activeUserEmail && (screenName === 'unlock' || screenName === 'create' || screenName === 'recovery')) {
      userPill.classList.remove('hidden');
      updateUserBadge(activeUserEmail);
    } else {
      userPill.classList.add('hidden');
    }
    lockPoolBtn.classList.add('hidden');
  }

  // Ekranın en üstüne kaydır
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateUserBadge(email) {
  if (!email) return;
  headerUserEmail.textContent = email;
  headerUserAvatar.textContent = email.charAt(0).toUpperCase();
}

// ============================================================
// Tema Yönetimi (Dark / Light Theme)
// ============================================================
function initTheme() {
  const savedTheme = localStorage.getItem('havuz_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = savedTheme ? savedTheme === 'dark' : prefersDark;

  applyTheme(isDark);

  themeToggleBtn.addEventListener('click', () => {
    const currentIsDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const nextIsDark = !currentIsDark;
    applyTheme(nextIsDark);
    localStorage.setItem('havuz_theme', nextIsDark ? 'dark' : 'light');
  });
}

function applyTheme(isDark) {
  if (isDark) {
    document.documentElement.setAttribute('data-theme', 'dark');
    themeSunIcon.classList.remove('hidden');
    themeMoonIcon.classList.add('hidden');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    themeSunIcon.classList.add('hidden');
    themeMoonIcon.classList.remove('hidden');
  }
}

// ============================================================
// Şifre Göster / Gizle ve Güç Göstergesi
// ============================================================
function initPasswordToggles() {
  document.querySelectorAll('.btn-toggle-pw').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      if (!input) return;

      const eyeOpen = btn.querySelector('.eye-open');
      const eyeClosed = btn.querySelector('.eye-closed');

      if (input.type === 'password') {
        input.type = 'text';
        if (eyeOpen) eyeOpen.classList.add('hidden');
        if (eyeClosed) eyeClosed.classList.remove('hidden');
      } else {
        input.type = 'password';
        if (eyeOpen) eyeOpen.classList.remove('hidden');
        if (eyeClosed) eyeClosed.classList.add('hidden');
      }
    });
  });
}

function initPasswordStrength() {
  const passwordInput = document.getElementById('create-password');
  const strengthFill = document.getElementById('strength-bar-fill');
  const strengthText = document.getElementById('strength-text');
  const charCount = document.getElementById('char-count');
  const confirmInput = document.getElementById('create-password-confirm');
  const matchError = document.getElementById('password-match-error');

  if (!passwordInput || !strengthFill) return;

  function evaluate() {
    const val = passwordInput.value;
    const len = val.length;
    charCount.textContent = `${len} / 10`;

    // Güç hesabı
    strengthFill.classList.remove('weak', 'medium', 'strong');
    strengthText.classList.remove('weak', 'medium', 'strong');

    if (len === 0) {
      strengthFill.style.width = '0%';
      strengthText.textContent = 'En az 10 karakter';
      return;
    }

    const hasNumbers = /\d/.test(val);
    const hasLetters = /[a-zA-ZçğıöşüÇĞİÖŞÜ]/.test(val);
    const hasSpecial = /[^a-zA-Z0-9çğıöşüÇĞİÖŞÜ]/.test(val);

    if (len < 10) {
      strengthFill.classList.add('weak');
      strengthText.classList.add('weak');
      strengthText.textContent = 'Yetersiz (en az 10 karakter)';
    } else if (len >= 12 && hasNumbers && hasLetters && hasSpecial) {
      strengthFill.classList.add('strong');
      strengthText.classList.add('strong');
      strengthText.textContent = 'Güçlü şifre';
    } else if (len >= 10 && (hasNumbers || hasSpecial)) {
      strengthFill.classList.add('medium');
      strengthText.classList.add('medium');
      strengthText.textContent = 'Orta güçte';
    } else {
      strengthFill.classList.add('weak');
      strengthText.classList.add('weak');
      strengthText.textContent = 'Zayıf (harf ve rakam ekle)';
    }

    // Eşleşme kontrolü
    if (confirmInput.value.length > 0) {
      if (confirmInput.value !== val) {
        matchError.classList.remove('hidden');
      } else {
        matchError.classList.add('hidden');
      }
    }
  }

  passwordInput.addEventListener('input', evaluate);
  confirmInput.addEventListener('input', () => {
    if (confirmInput.value !== passwordInput.value) {
      matchError.classList.remove('hidden');
    } else {
      matchError.classList.add('hidden');
    }
  });
}

// ============================================================
// 1. EKRAN: Karşılama
// ============================================================
function initWelcomeScreen() {
  const signInBtn = document.getElementById('google-signin-btn');
  if (!signInBtn) return;

  signInBtn.addEventListener('click', async () => {
    try {
      signInBtn.disabled = true;
      signInBtn.classList.add('btn-loading');

      // havuz.signIn() doğrudan tıklama içinde çağrılır
      const res = await havuz.signIn();
      activeUserEmail = res.email;

      if (res.step === 'create') {
        const createEmailEl = document.getElementById('create-user-email');
        const usernameHidden = document.getElementById('create-username-hidden');
        if (createEmailEl) createEmailEl.textContent = res.email;
        if (usernameHidden) usernameHidden.value = res.email;
        navigateTo('create');
      } else {
        const unlockEmailEl = document.getElementById('unlock-user-email');
        const unlockAvatar = document.getElementById('unlock-avatar');
        const usernameHidden = document.getElementById('unlock-username-hidden');
        if (unlockEmailEl) unlockEmailEl.textContent = res.email;
        if (unlockAvatar) unlockAvatar.textContent = res.email.charAt(0).toUpperCase();
        if (usernameHidden) usernameHidden.value = res.email;
        navigateTo('unlock');
      }
    } catch (err) {
      showToast(err.message || 'Google ile giriş yapılırken bir sorun oluştu.', 'error');
    } finally {
      signInBtn.disabled = false;
      signInBtn.classList.remove('btn-loading');
    }
  });
}

// ============================================================
// 2. EKRAN: Yeni Havuz Oluştur
// ============================================================
function initCreateScreen() {
  const form = document.getElementById('create-pool-form');
  const passwordInput = document.getElementById('create-password');
  const confirmInput = document.getElementById('create-password-confirm');
  const submitBtn = document.getElementById('create-submit-btn');

  if (!form) return;

  form.addEventListener('submit', async e => {
    e.preventDefault();

    const password = passwordInput.value;
    const confirm = confirmInput.value;

    if (!password || password.length < 10) {
      showToast('Şifre en az 10 karakter uzunluğunda olmalıdır.', 'error');
      passwordInput.focus();
      return;
    }

    if (password !== confirm) {
      showToast('Girdiğin şifreler birbiriyle eşleşmiyor.', 'error');
      confirmInput.focus();
      return;
    }

    try {
      submitBtn.disabled = true;
      // createPool doğrudan tıklama içinde çağrılır
      const recoveryKey = await havuz.createPool(password);

      // 3. Ekrana geç (Kurtarma Anahtarı)
      const keyTextEl = document.getElementById('recovery-key-text');
      if (keyTextEl) keyTextEl.textContent = recoveryKey;

      const checkbox = document.getElementById('recovery-confirmed-checkbox');
      const continueBtn = document.getElementById('recovery-continue-btn');
      if (checkbox) checkbox.checked = false;
      if (continueBtn) continueBtn.disabled = true;

      navigateTo('recovery');
      showToast('Havuzun başarıyla oluşturuldu! Kurtarma anahtarını kaydet.', 'success');
    } catch (err) {
      showToast(err.message || 'Havuz oluşturulamadı.', 'error');
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ============================================================
// 3. EKRAN: Kurtarma Anahtarı
// ============================================================
function initRecoveryScreen() {
  const copyBtn = document.getElementById('copy-recovery-key-btn');
  const copyLabel = document.getElementById('copy-key-label');
  const keyTextEl = document.getElementById('recovery-key-text');
  const checkbox = document.getElementById('recovery-confirmed-checkbox');
  const continueBtn = document.getElementById('recovery-continue-btn');

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const key = keyTextEl.textContent.trim();
      try {
        await navigator.clipboard.writeText(key);
        copyLabel.textContent = 'Kopyalandı!';
        showToast('Kurtarma anahtarı panoya kopyalandı.', 'success');
        setTimeout(() => {
          copyLabel.textContent = 'Kopyala';
        }, 2200);
      } catch (err) {
        showToast('Anahtar kopyalanamadı, lütfen elle seçip kopyala.', 'error');
      }
    });
  }

  if (checkbox && continueBtn) {
    checkbox.addEventListener('change', () => {
      continueBtn.disabled = !checkbox.checked;
    });

    continueBtn.addEventListener('click', () => {
      if (checkbox.checked) {
        navigateTo('dashboard');
        showToast('Havuzuna hoş geldin! Dosyalarını güvenle yükleyebilirsin.', 'success');
      }
    });
  }
}

// ============================================================
// 4. EKRAN: Havuzu Aç (Unlock)
// ============================================================
function initUnlockScreen() {
  const form = document.getElementById('unlock-pool-form');
  const passwordInput = document.getElementById('unlock-password');
  const submitBtn = document.getElementById('unlock-submit-btn');
  const goForgotBtn = document.getElementById('go-forgot-pw-btn');

  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const password = passwordInput.value;

      if (!password) {
        showToast('Lütfen havuz şifreni gir.', 'error');
        passwordInput.focus();
        return;
      }

      try {
        submitBtn.disabled = true;
        await havuz.unlock(password);
        passwordInput.value = '';
        navigateTo('dashboard');
        showToast('Havuz açıldı.', 'success');
      } catch (err) {
        showToast(err.message || 'Şifre hatalı.', 'error');
        passwordInput.focus();
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  if (goForgotBtn) {
    goForgotBtn.addEventListener('click', () => {
      navigateTo('forgot');
    });
  }
}

// ============================================================
// 5. EKRAN: Şifremi Unuttum (Forgot / Recover)
// ============================================================
function initForgotScreen() {
  const form = document.getElementById('forgot-pool-form');
  const keyInput = document.getElementById('recover-key-input');
  const newPasswordInput = document.getElementById('recover-password');
  const confirmPasswordInput = document.getElementById('recover-password-confirm');
  const submitBtn = document.getElementById('recover-submit-btn');
  const backBtn = document.getElementById('back-to-unlock-btn');

  if (form) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const recoveryKey = keyInput.value.trim();
      const newPassword = newPasswordInput.value;
      const confirmPassword = confirmPasswordInput.value;

      if (!recoveryKey) {
        showToast('Lütfen kurtarma anahtarını gir.', 'error');
        keyInput.focus();
        return;
      }

      if (!newPassword || newPassword.length < 10) {
        showToast('Yeni şifre en az 10 karakter olmalıdır.', 'error');
        newPasswordInput.focus();
        return;
      }

      if (newPassword !== confirmPassword) {
        showToast('Yeni şifreler eşleşmiyor.', 'error');
        confirmPasswordInput.focus();
        return;
      }

      try {
        submitBtn.disabled = true;
        await havuz.recover(recoveryKey, newPassword);
        keyInput.value = '';
        newPasswordInput.value = '';
        confirmPasswordInput.value = '';
        navigateTo('dashboard');
        showToast('Yeni şifren kaydedildi ve havuz açıldı!', 'success');
      } catch (err) {
        showToast(err.message || 'Kurtarma işlemi başarısız oldu.', 'error');
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  if (backBtn) {
    backBtn.addEventListener('click', () => {
      navigateTo('unlock');
    });
  }
}

// ============================================================
// 6. ANA EKRAN: Dashboard Render & Eylemler
// ============================================================
function renderDashboard(status) {
  if (!status) return;

  // 1. Doluluk Göstergesi
  const percentTextEl = document.getElementById('dash-percent-text');
  const usedTotalTextEl = document.getElementById('dash-used-total-text');
  const canStoreTextEl = document.getElementById('dash-can-store-text');
  const progressBarFill = document.getElementById('storage-progress-bar-fill');

  const percent = status.percent || 0;
  // 1 decimal under 10%, whole numbers above: '%3.4 dolu', '%25 dolu'
  if (percentTextEl) percentTextEl.textContent = `%${percent < 10 ? percent.toFixed(1) : Math.round(percent)} dolu`;
  if (usedTotalTextEl) usedTotalTextEl.textContent = `${human(status.used)} / ${human(status.limit)}`;
  if (canStoreTextEl) canStoreTextEl.textContent = `Daha ${human(status.canStillStore)} sığar`;

  if (progressBarFill) {
    progressBarFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (percent >= 90) {
      progressBarFill.classList.add('warning');
    } else {
      progressBarFill.classList.remove('warning');
    }
  }

  // 2. Koruma Durumu Rozeti
  const protectionCard = document.getElementById('protection-status-card');
  const protectionTitle = document.getElementById('protection-status-title');
  const protectionIconWrap = document.getElementById('protection-icon-container');
  const protectionAddBtn = document.getElementById('protection-add-acc-btn');

  if (protectionCard && protectionTitle && protectionIconWrap) {
    protectionCard.classList.remove('protection-parity', 'protection-copy', 'protection-none');

    if (status.protection === 'parity') {
      protectionCard.classList.add('protection-parity');
      protectionTitle.textContent = 'Bir hesap kaybolsa da dosyaların güvende';
      protectionIconWrap.innerHTML = ICONS.shield;
      if (protectionAddBtn) protectionAddBtn.classList.add('hidden');
    } else if (status.protection === 'copy') {
      protectionCard.classList.add('protection-copy');
      protectionTitle.textContent = 'Her dosya iki hesapta duruyor';
      protectionIconWrap.innerHTML = ICONS.copy;
      if (protectionAddBtn) protectionAddBtn.classList.add('hidden');
    } else if (status.protection === 'none') {
      protectionCard.classList.add('protection-none');
      protectionTitle.textContent = 'Korumasız: bu hesap kaybolursa dosyalar gider. Bir hesap daha ekle';
      protectionIconWrap.innerHTML = ICONS.alert;
      if (protectionAddBtn) {
        protectionAddBtn.classList.remove('hidden');
        protectionAddBtn.onclick = () => openAddAccountModal();
      }
    } else {
      protectionCard.classList.add('protection-none');
      protectionTitle.textContent = 'Henüz hesap eklenmemiş';
      protectionIconWrap.innerHTML = ICONS.alert;
      if (protectionAddBtn) protectionAddBtn.classList.remove('hidden');
    }
  }

  // 3. Dosya Listesi
  renderFileList(status.files || []);

  // 4. Hesaplar Listesi
  renderAccountsList(status.accounts || []);
}

function getFileCategoryIcon(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) {
    return ICONS.image;
  }
  if (['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv'].includes(ext)) {
    return ICONS.video;
  }
  if (['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv'].includes(ext)) {
    return ICONS.doc;
  }
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(ext)) {
    return ICONS.archive;
  }
  return ICONS.file;
}

function formatRelativeDate(timestamp) {
  if (!timestamp) return '';
  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);

  if (diffSec < 60) return 'Az önce';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} dakika önce`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} saat önce`;
  const diffDays = Math.floor(diffSec / 86400);
  if (diffDays === 1) return 'Dün';
  if (diffDays < 30) return `${diffDays} gün önce`;

  const date = new Date(timestamp);
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

function renderFileList(files) {
  const countBadge = document.getElementById('files-count-badge');
  const emptyState = document.getElementById('files-empty-state');
  const tableContainer = document.getElementById('files-list-table');

  if (!tableContainer) return;

  const filtered = files.filter(f => f.name.toLowerCase().includes(currentSearchTerm.toLowerCase()));

  if (countBadge) {
    countBadge.textContent = files.length;
  }

  tableContainer.innerHTML = '';

  if (files.length === 0) {
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  if (filtered.length === 0) {
    const noMatch = document.createElement('div');
    noMatch.className = 'empty-state';
    noMatch.innerHTML = `
      <h4 class="empty-title">Aramana uygun dosya bulunamadı</h4>
      <p class="empty-desc">"${escapeHtml(currentSearchTerm)}" ile eşleşen bir dosya yok.</p>
    `;
    tableContainer.appendChild(noMatch);
    return;
  }

  filtered.forEach(file => {
    const row = document.createElement('div');
    row.className = 'file-row';

    const mainInfo = document.createElement('div');
    mainInfo.className = 'file-main-info';

    const iconDiv = document.createElement('div');
    iconDiv.className = 'file-type-icon';
    iconDiv.innerHTML = getFileCategoryIcon(file.name);

    const nameMeta = document.createElement('div');
    nameMeta.className = 'file-name-meta';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file.name;
    nameSpan.title = file.name;

    const metaRow = document.createElement('div');
    metaRow.className = 'file-meta-row';
    metaRow.innerHTML = `<span>${human(file.size)}</span> &bull; <span>${formatRelativeDate(file.created)}</span>`;

    nameMeta.appendChild(nameSpan);
    nameMeta.appendChild(metaRow);
    mainInfo.appendChild(iconDiv);
    mainInfo.appendChild(nameMeta);

    const actions = document.createElement('div');
    actions.className = 'file-actions';

    // İndir Butonu
    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'action-btn';
    downloadBtn.title = 'İndir';
    downloadBtn.setAttribute('aria-label', `${file.name} dosyasını indir`);
    downloadBtn.innerHTML = ICONS.download;

    downloadBtn.addEventListener('click', async () => {
      try {
        downloadBtn.disabled = true;
        const res = await havuz.download(file.name);

        // Tarayıcı indirmesi tetikle
        const url = URL.createObjectURL(res.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // rebuilt varsa uyar
        if (res.rebuilt) {
          showToast(`"${res.name}" indirildi (eksik parçalar otomatik onarıldı).`, 'success', 5000);
        } else {
          showToast(`"${res.name}" indirildi.`, 'success');
        }
      } catch (err) {
        showToast(err.message || 'Dosya indirilemedi.', 'error');
      } finally {
        downloadBtn.disabled = false;
      }
    });

    // Sil Butonu (Özel Onay Penceresi Açar)
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'action-btn btn-delete';
    deleteBtn.title = 'Sil';
    deleteBtn.setAttribute('aria-label', `${file.name} dosyasını sil`);
    deleteBtn.innerHTML = ICONS.trash;

    deleteBtn.addEventListener('click', () => {
      openDeleteModal(file.name);
    });

    actions.appendChild(downloadBtn);
    actions.appendChild(deleteBtn);

    row.appendChild(mainInfo);
    row.appendChild(actions);
    tableContainer.appendChild(row);
  });
}

function renderAccountsList(accounts) {
  const container = document.getElementById('accounts-list-container');
  const headerTitle = document.getElementById('accounts-header-title');

  if (headerTitle) {
    headerTitle.textContent = `Hesaplar (${accounts.length})`;
  }

  if (!container) return;
  container.innerHTML = '';

  accounts.forEach(acc => {
    const card = document.createElement('div');
    card.className = 'account-card';

    const topRow = document.createElement('div');
    topRow.className = 'account-card-top';

    const emailWrap = document.createElement('div');
    emailWrap.className = 'account-email-wrap';

    const emailSpan = document.createElement('span');
    emailSpan.className = 'account-email';
    emailSpan.textContent = acc.email;
    emailWrap.appendChild(emailSpan);

    const badges = document.createElement('div');
    badges.className = 'account-badges';

    if (acc.main) {
      const mainBadge = document.createElement('span');
      mainBadge.className = 'badge badge-main';
      mainBadge.textContent = 'ana';
      badges.appendChild(mainBadge);
    }

    if (acc.reachable === false) {
      const warnBadge = document.createElement('span');
      warnBadge.className = 'badge badge-unreachable';
      warnBadge.textContent = 'erişilemiyor';
      badges.appendChild(warnBadge);
    }

    topRow.appendChild(emailWrap);
    topRow.appendChild(badges);

    const usageRow = document.createElement('div');
    usageRow.className = 'account-usage-row';

    const usageText = document.createElement('div');
    usageText.className = 'account-usage-text';
    const accUsed = acc.used || 0;
    const accLimit = acc.limit || 15 * 1024 * 1024 * 1024;
    const accPercent = Math.min(100, Math.round((accUsed / accLimit) * 100));

    usageText.innerHTML = `<span>${human(accUsed)} / ${human(accLimit)}</span><span>%${accPercent}</span>`;

    const progressTrack = document.createElement('div');
    progressTrack.className = 'account-progress-track';

    const progressFill = document.createElement('div');
    progressFill.className = 'account-progress-fill';
    progressFill.style.width = `${accPercent}%`;

    progressTrack.appendChild(progressFill);
    usageRow.appendChild(usageText);
    usageRow.appendChild(progressTrack);

    card.appendChild(topRow);
    card.appendChild(usageRow);
    container.appendChild(card);
  });
}

// ============================================================
// Dosya Yükleme (Dropzone ve Sıralı Kuyruk)
// ============================================================
function initDropzone() {
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', e => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesSelected(Array.from(e.target.files));
      fileInput.value = '';
    }
  });

  // Masaüstü sürükle bırak
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', e => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelected(Array.from(e.dataTransfer.files));
    }
  });
}

function handleFilesSelected(files) {
  if (!files || files.length === 0) return;

  for (const file of files) {
    uploadQueue.push({
      file,
      progress: 0,
      status: 'pending' // pending | uploading | done | error
    });
  }

  processUploadQueue();
}

async function processUploadQueue() {
  if (isUploading) return;
  const nextItem = uploadQueue.find(item => item.status === 'pending');
  if (!nextItem) {
    updateQueueUI();
    return;
  }

  isUploading = true;
  nextItem.status = 'uploading';
  updateQueueUI();

  try {
    await havuz.upload(nextItem.file, percent => {
      nextItem.progress = percent;
      updateQueueUI();
    });
    nextItem.status = 'done';
    showToast(`"${nextItem.file.name}" yüklendi.`, 'success');
  } catch (err) {
    nextItem.status = 'error';
    showToast(err.message || `"${nextItem.file.name}" yüklenemedi.`, 'error');
  } finally {
    isUploading = false;
    // Bitenleri bir süre sonra listeden temizle
    setTimeout(() => {
      const idx = uploadQueue.indexOf(nextItem);
      if (idx !== -1) uploadQueue.splice(idx, 1);
      updateQueueUI();
    }, 1200);

    // Sıradaki dosyaya geç
    processUploadQueue();
  }
}

function updateQueueUI() {
  const container = document.getElementById('upload-queue-container');
  const countText = document.getElementById('queue-count-text');
  const itemsContainer = document.getElementById('upload-queue-items');

  if (!container || !itemsContainer) return;

  if (uploadQueue.length === 0) {
    container.classList.add('hidden');
    return;
  }

  container.classList.remove('hidden');
  const doneCount = uploadQueue.filter(i => i.status === 'done').length;
  countText.textContent = `${doneCount} / ${uploadQueue.length}`;

  itemsContainer.innerHTML = '';
  uploadQueue.forEach(item => {
    const row = document.createElement('div');
    row.className = 'queue-item-row';

    const meta = document.createElement('div');
    meta.className = 'queue-item-meta';

    const name = document.createElement('span');
    name.className = 'queue-filename';
    name.textContent = item.file.name;

    const percent = document.createElement('span');
    percent.className = 'queue-percent';
    percent.textContent = item.status === 'error' ? 'Hata' : `%${Math.round(item.progress || 0)}`;

    meta.appendChild(name);
    meta.appendChild(percent);

    const track = document.createElement('div');
    track.className = 'queue-progress-track';

    const bar = document.createElement('div');
    bar.className = 'queue-progress-bar';
    bar.style.width = `${item.progress}%`;

    track.appendChild(bar);
    row.appendChild(meta);
    row.appendChild(track);
    itemsContainer.appendChild(row);
  });
}

// ============================================================
// Hesap Ekleme Modalı (+ Hesap Ekle)
// ============================================================
function initAddAccountModal() {
  const openBtn = document.getElementById('open-add-account-btn');
  const closeX = document.getElementById('close-add-acc-x');
  const cancelBtn = document.getElementById('modal-cancel-add-acc-btn');
  const copyBtn = document.getElementById('modal-copy-code-btn');
  const copyLabel = document.getElementById('modal-copy-code-label');
  const codeDisplay = document.getElementById('modal-device-code');

  if (openBtn) {
    openBtn.addEventListener('click', e => {
      e.stopPropagation();
      openAddAccountModal();
    });
  }

  if (closeX) closeX.addEventListener('click', closeAddAccountModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeAddAccountModal);

  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const code = codeDisplay.textContent.trim();
      try {
        await navigator.clipboard.writeText(code);
        copyLabel.textContent = 'Kopyalandı!';
        showToast('Cihaz kodu panoya kopyalandı.', 'success');
        setTimeout(() => {
          copyLabel.textContent = 'Kopyala';
        }, 2000);
      } catch (err) {
        showToast('Kod kopyalanamadı.', 'error');
      }
    });
  }
}

async function openAddAccountModal() {
  if (addAccountAbortController) {
    addAccountAbortController.abort();
  }
  addAccountAbortController = new AbortController();

  const codeDisplay = document.getElementById('modal-device-code');
  const urlLink = document.getElementById('modal-device-url');
  const connectingState = document.getElementById('modal-connecting-state');

  codeDisplay.textContent = '---- - ----';
  connectingState.innerHTML = '<div class="spinner-dot"></div><span>Kod oluşturuluyor...</span>';

  modalAddAccount.classList.remove('hidden');

  try {
    const newEmail = await havuz.addAccount({
      onCode: ({ code, url }) => {
        codeDisplay.textContent = code;
        if (urlLink) {
          urlLink.href = url;
          urlLink.childNodes[0].nodeValue = url.replace(/^https?:\/\//, '') + ' ';
        }
        connectingState.innerHTML = '<div class="spinner-dot"></div><span>Google onay bekleniyor...</span>';
      },
      signal: addAccountAbortController.signal
    });

    connectingState.innerHTML = '<span class="added-ok">Hesap eklendi!</span>';
    showToast(`Yeni hesap başarıyla bağlandı: ${newEmail}`, 'success');

    setTimeout(() => {
      modalAddAccount.classList.add('hidden');
    }, 900);
  } catch (err) {
    if (err.code !== 'cancelled') {
      showToast(err.message || 'Hesap eklenemedi.', 'error');
    }
    modalAddAccount.classList.add('hidden');
  }
}

function closeAddAccountModal() {
  if (addAccountAbortController) {
    addAccountAbortController.abort();
    addAccountAbortController = null;
  }
  modalAddAccount.classList.add('hidden');
}

// ============================================================
// Dosya Silme Onay Modalı (Custom Confirm)
// ============================================================
function initDeleteConfirmModal() {
  const cancelBtn = document.getElementById('delete-cancel-btn');
  const confirmBtn = document.getElementById('delete-confirm-btn');

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      modalDeleteConfirm.classList.add('hidden');
      currentFileToDelete = null;
    });
  }

  if (confirmBtn) {
    confirmBtn.addEventListener('click', async () => {
      if (!currentFileToDelete) return;
      const targetName = currentFileToDelete;
      try {
        confirmBtn.disabled = true;
        await havuz.remove(targetName);
        modalDeleteConfirm.classList.add('hidden');
        showToast(`"${targetName}" silindi.`, 'info');
      } catch (err) {
        showToast(err.message || 'Dosya silinemedi.', 'error');
      } finally {
        confirmBtn.disabled = false;
        currentFileToDelete = null;
      }
    });
  }
}

function openDeleteModal(fileName) {
  currentFileToDelete = fileName;
  const targetLabel = document.getElementById('delete-file-name-target');
  if (targetLabel) targetLabel.textContent = fileName;
  modalDeleteConfirm.classList.remove('hidden');
}

// ============================================================
// Arama ve Katlanabilir Bölüm (Accordion)
// ============================================================
function initSearchAndAccordion() {
  const searchInput = document.getElementById('file-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      currentSearchTerm = e.target.value.trim();
      const st = havuz.status();
      renderFileList(st.files || []);
    });
  }

  const toggleBtn = document.getElementById('accounts-toggle-btn');
  const body = document.getElementById('accounts-body');

  if (toggleBtn && body) {
    toggleBtn.addEventListener('click', () => {
      const isExpanded = toggleBtn.getAttribute('aria-expanded') === 'true';
      toggleBtn.setAttribute('aria-expanded', !isExpanded);
      if (isExpanded) {
        body.classList.add('collapsed');
      } else {
        body.classList.remove('collapsed');
      }
    });
  }
}

// ============================================================
// Havuzu Kilitle ve Demo Kontrolleri
// ============================================================
function initControls() {
  if (lockPoolBtn) {
    lockPoolBtn.addEventListener('click', () => {
      if (typeof havuz.lock === 'function') {
        havuz.lock();
      }
      navigateTo('unlock');
      showToast('Havuz kilitlendi.', 'info');
    });
  }

  // demo-only buttons exist just for the mock API
  if (typeof havuz.resetDemo !== 'function') {
    document.querySelector('.footer-demo-links')?.classList.add('hidden')
  }
  const demoResetBtn = document.getElementById('demo-reset-btn');
  if (demoResetBtn) {
    demoResetBtn.addEventListener('click', () => {
      if (typeof havuz.resetDemo === 'function') {
        havuz.resetDemo();
        showToast('Örnek veriler sıfırlandı.', 'success');
      }
    });
  }

  const demoToggleProtectionBtn = document.getElementById('demo-toggle-protection-btn');
  if (demoToggleProtectionBtn) {
    let modeIndex = 0;
    demoToggleProtectionBtn.addEventListener('click', () => {
      if (typeof havuz.setProtectionDemo === 'function') {
        modeIndex = (modeIndex + 1) % 3;
        const counts = [1, 2, 4]; // 1: none (kırmızı), 2: copy (yeşil), 4: parity (yeşil)
        havuz.setProtectionDemo(counts[modeIndex]);
        const labels = ['Korumasız (1 hesap)', 'Kopya Koruması (2 hesap)', 'Parite Koruması (4 hesap)'];
        showToast(`Koruma modu test edildi: ${labels[modeIndex]}`, 'info');
      }
    });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

// ============================================================
// Uygulama Başlangıcı (Initialization)
// ============================================================
function init() {
  initTheme();
  initPasswordToggles();
  initPasswordStrength();
  initWelcomeScreen();
  initCreateScreen();
  initRecoveryScreen();
  initUnlockScreen();
  initForgotScreen();
  initDropzone();
  initAddAccountModal();
  initDeleteConfirmModal();
  initSearchAndAccordion();
  initControls();

  // havuz.onChange dinleyicisini bağla
  havuz.onChange(status => {
    if (currentScreen === 'dashboard') {
      renderDashboard(status);
    }
  });

  // Başlangıç ekranını belirle
  const status = havuz.status();
  if (status.isCreated && status.isUnlocked) {
    activeUserEmail = status.email;
    navigateTo('dashboard');
  } else if (status.isCreated) {
    activeUserEmail = status.email;
    const unlockEmailEl = document.getElementById('unlock-user-email');
    const unlockAvatar = document.getElementById('unlock-avatar');
    if (unlockEmailEl) unlockEmailEl.textContent = status.email;
    if (unlockAvatar) unlockAvatar.textContent = status.email.charAt(0).toUpperCase();
    navigateTo('unlock');
  } else {
    navigateTo('welcome');
  }
}

// Sayfa yüklendiğinde başlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
