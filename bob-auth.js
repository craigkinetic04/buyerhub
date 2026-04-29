// ============================================================
// Bank on Brooke — Shared Auth Library
//
// Drop this <script> tag near the top of your HTML BEFORE bob-api.js:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="bob-auth.js"></script>
//
// Configure SUPABASE_URL and SUPABASE_ANON_KEY below before deploying.
// ============================================================

(function (global) {
  'use strict';

  // ── CONFIG ─────────────────────────────────────────────
  // Replace with YOUR project values from Settings -> API
  const SUPABASE_URL      = 'https://fegzfjftfgqjjgatihyi.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlZ3pmamZ0ZmdxampnYXRpaHlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0ODYyMDksImV4cCI6MjA5MzA2MjIwOX0.38cKicsDRlkbfgLLjvZnu-M_d7TatAfTQXf1jqZrunM';  // ← paste your anon public key

  // ── INIT ───────────────────────────────────────────────
  if (!global.supabase || !global.supabase.createClient) {
    console.error('[bob-auth] Supabase JS client not loaded. Add <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script> BEFORE bob-auth.js.');
    return;
  }

  const sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,        // keeps user logged in across reloads
      autoRefreshToken: true,      // silently refreshes expiring tokens
      detectSessionInUrl: true,    // handles email confirmation links
    },
  });

  // ── STATE ──────────────────────────────────────────────
  // Cached realtor profile row from the realtors table
  let _realtorProfile = null;
  let _profileLoadedFor = null;

  // ── PUBLIC API ─────────────────────────────────────────
  const BobAuth = {
    /**
     * Returns the underlying Supabase client.
     * Use BobApi instead unless you need raw access.
     */
    client() { return sb; },

    /**
     * Gets the current logged-in auth user (or null).
     * Returns: { id, email } | null
     */
    async currentUser() {
      const { data, error } = await sb.auth.getUser();
      if (error || !data?.user) return null;
      return data.user;
    },

    /**
     * Gets the realtor profile row for the current logged-in user.
     * Returns the realtors table row or null. Cached after first load.
     */
    async currentRealtor() {
      const user = await this.currentUser();
      if (!user) return null;

      if (_profileLoadedFor === user.id && _realtorProfile) {
        return _realtorProfile;
      }

      const { data, error } = await sb
        .from('realtors')
        .select('*')
        .eq('auth_user_id', user.id)
        .single();

      if (error || !data) {
        console.error('[bob-auth] Could not load realtor profile:', error);
        return null;
      }

      _realtorProfile = data;
      _profileLoadedFor = user.id;
      return data;
    },

    /**
     * Sign up a new Realtor.
     *
     * Flow:
     * 1. Create the auth user (Supabase sends a confirmation email by default;
     *    we disable that in the dashboard for invite-based flow OR send the
     *    email and have them click a link)
     * 2. Create the matching realtors row, linked via auth_user_id
     *
     * @param {Object} payload  - { name, company, phone, email, password, ridFromInvite }
     * @returns {Object}        - { realtor, user } on success
     * @throws  {Error}         - on validation or Supabase error
     */
    async signUp({ name, company, phone, email, password, ridFromInvite }) {
      if (!name || !email || !password) {
        throw new Error('Name, email, and password are required.');
      }
      if (password.length < 8) {
        throw new Error('Password must be at least 8 characters.');
      }

      const cleanEmail = email.trim().toLowerCase();

      // 1. Create auth user. We pass metadata so the trigger has it.
      const { data: signupData, error: signupErr } = await sb.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: {
            full_name: name.trim(),
            company: company?.trim() || null,
            phone:   phone?.trim() || null,
            invite_rid: ridFromInvite || null,
          },
        },
      });

      if (signupErr) {
        // Friendly errors for common cases
        if (/already registered/i.test(signupErr.message)) {
          throw new Error('An account with this email already exists. Please log in instead.');
        }
        throw new Error(signupErr.message);
      }

      if (!signupData?.user) {
        throw new Error('Signup did not return a user. Check Supabase email confirmation settings.');
      }

      // 2. Create realtors profile row
      const { data: realtor, error: realtorErr } = await sb
        .from('realtors')
        .insert({
          auth_user_id: signupData.user.id,
          name:    name.trim(),
          company: company?.trim() || null,
          phone:   phone?.trim() || null,
          email:   cleanEmail,
        })
        .select()
        .single();

      if (realtorErr) {
        // Try to clean up the orphaned auth user if we can
        console.error('[bob-auth] Profile creation failed after auth signup:', realtorErr);
        throw new Error('Account created but profile setup failed. Contact support: ' + realtorErr.message);
      }

      _realtorProfile = realtor;
      _profileLoadedFor = signupData.user.id;

      return { user: signupData.user, realtor };
    },

    /**
     * Log in an existing Realtor with email + password.
     * Returns { user, realtor } on success.
     */
    async signIn({ email, password }) {
      if (!email || !password) {
        throw new Error('Email and password are required.');
      }

      const { data, error } = await sb.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (error) {
        if (/invalid/i.test(error.message)) {
          throw new Error('Incorrect email or password. Try again.');
        }
        if (/not confirmed/i.test(error.message)) {
          throw new Error('Please confirm your email first. Check your inbox for the confirmation link.');
        }
        throw new Error(error.message);
      }

      // Update last_login_at (fire and forget, don't block login)
      sb.from('realtors')
        .update({ last_login_at: new Date().toISOString() })
        .eq('auth_user_id', data.user.id)
        .then(() => {}, () => {});

      const realtor = await this.currentRealtor();
      return { user: data.user, realtor };
    },

    /**
     * Send a password reset email.
     */
    async resetPassword(email) {
      if (!email) throw new Error('Email is required.');
      const redirectTo = window.location.origin + window.location.pathname + '?reset=1';
      const { error } = await sb.auth.resetPasswordForEmail(
        email.trim().toLowerCase(),
        { redirectTo }
      );
      if (error) throw new Error(error.message);
      return true;
    },

    /**
     * Update password (used after a reset link click).
     */
    async updatePassword(newPassword) {
      if (!newPassword || newPassword.length < 8) {
        throw new Error('Password must be at least 8 characters.');
      }
      const { error } = await sb.auth.updateUser({ password: newPassword });
      if (error) throw new Error(error.message);
      return true;
    },

    /**
     * Sign out the current user. Clears local session.
     */
    async signOut() {
      _realtorProfile = null;
      _profileLoadedFor = null;
      const { error } = await sb.auth.signOut();
      if (error) console.warn('[bob-auth] Sign out warning:', error);
      return true;
    },

    /**
     * Subscribes to auth state changes (login, logout, token refresh).
     * Pass a callback that receives ({event, session}).
     * Returns an unsubscribe function.
     */
    onAuthChange(callback) {
      const { data } = sb.auth.onAuthStateChange((event, session) => {
        // Clear cached profile on any non-token event
        if (event !== 'TOKEN_REFRESHED') {
          _realtorProfile = null;
          _profileLoadedFor = null;
        }
        callback({ event, session });
      });
      return () => data?.subscription?.unsubscribe();
    },

    /**
     * Quick check if someone is logged in. Cheap call; safe to use in render loops.
     */
    async isLoggedIn() {
      const { data } = await sb.auth.getSession();
      return !!data?.session;
    },
  };

  // Expose globally
  global.BobAuth = BobAuth;

})(window);
