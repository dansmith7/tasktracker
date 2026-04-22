/**
 * Офлайн-режим разработки без Supabase: данные в localStorage.
 *
 * - VITE_LOCAL_DEV_MOCK=1 — сразу открыть приложение без экрана входа.
 * - VITE_DEV_LOGIN_ANY=1 (только import.meta.env.DEV) — экран входа, принимается любой email и пароль.
 */
export const DEV_LOCAL_USER_ID = '11111111-1111-4111-8111-111111111111'

export function isLocalDevMock() {
  const v = import.meta.env.VITE_LOCAL_DEV_MOCK
  return v === '1' || v === 'true'
}

/** Локально: форма входа, любые учётные данные; те же данные, что и мок (localStorage). */
export function isDevLoginAny() {
  if (!import.meta.env.DEV) return false
  const v = import.meta.env.VITE_DEV_LOGIN_ANY
  return v === '1' || v === 'true'
}

/** Любой из офлайн-режимов: не используем Supabase для auth и данных. */
export function isOfflineDevMode() {
  return isLocalDevMock() || isDevLoginAny()
}

/** Можно вызывать API слоя данных (реальный Supabase или локальный мок). */
export function canUseDataApi(supabase) {
  return Boolean(supabase) || isOfflineDevMode()
}
