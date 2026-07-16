/**
 * Application Configuration
 * Frontend constants, API base URL, feature flags.
 */
window.APP_CONFIG = {
  API_BASE: '/api',
  SUPABASE_URL: 'https://your-project.supabase.co', // Replace with env or real URL
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  CURRENCY: 'NGN',
  LOCALE: 'en-NG',
  TELEGRAM_ENABLED: true,
  MAINTENANCE_MODE: false // Overridden by backend check
};
