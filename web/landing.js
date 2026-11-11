// apply the theme the user picked inside the app (the page follows the system theme otherwise)
try {
  const t = localStorage.getItem('havuz_theme')
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t)
} catch {}
