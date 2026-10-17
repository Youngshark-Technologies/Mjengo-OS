'use client'

// MJG-009b — Auth: split-screen sign in / organization registration.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Boxes, ClipboardCheck, HardHat, Loader2, Wallet } from 'lucide-react'

import { api } from '@/lib/api-client'
import { useAppStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const PROOF_POINTS = [
  { icon: ClipboardCheck, label: 'Human-verified site evidence' },
  { icon: Boxes, label: 'Live materials & stock' },
  { icon: Wallet, label: 'Owner-approved payments' },
]

export function AuthView({ onAuthed }: { onAuthed: () => void }) {
  const mode = useAppStore((s) => s.authMode)
  const setAuthMode = useAppStore((s) => s.setAuthMode)

  const [name, setName] = useState('')
  const [organizationName, setOrganizationName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const login = useMutation({
    mutationFn: () => api.post('/api/auth/login', { email: email.trim(), password }),
    onSuccess: () => onAuthed(),
    onError: (e: Error) => setError(e.message),
  })

  const register = useMutation({
    mutationFn: () =>
      api.post('/api/auth/register', {
        name: name.trim(),
        email: email.trim(),
        password,
        organizationName: organizationName.trim(),
      }),
    onSuccess: () => onAuthed(),
    onError: (e: Error) => setError(e.message),
  })

  const pending = login.isPending || register.isPending
  const canLogin = email.trim() !== '' && password !== ''
  const canRegister =
    name.trim() !== '' &&
    organizationName.trim() !== '' &&
    email.trim() !== '' &&
    password.length >= 8

  const clearError = () => {
    if (error !== null) setError(null)
  }

  const switchMode = (next: 'login' | 'register') => {
    clearError()
    setAuthMode(next)
  }

  return (
    <div className="flex min-h-screen bg-stone-50">
      {/* Brand panel */}
      <aside className="relative hidden w-1/2 flex-col justify-center overflow-hidden bg-stone-950 p-10 md:flex xl:p-16">
        {/* Blueprint grid */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(rgba(245, 158, 11, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(245, 158, 11, 0.05) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />
        {/* Amber glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 55% 45% at 22% 18%, rgba(245, 158, 11, 0.15), transparent 70%)',
          }}
        />

        <div className="relative z-10 flex flex-col gap-10">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-amber-500">
              <HardHat className="size-5 text-stone-950" aria-hidden />
            </div>
            <span className="text-2xl font-semibold tracking-tight text-white">
              Mjengo<span className="text-amber-500">OS</span>
            </span>
          </div>

          <div>
            <p className="max-w-md text-2xl leading-snug font-medium text-white xl:text-3xl">
              The evidence-backed operating system for construction.
            </p>
          </div>

          <ul className="flex flex-col gap-5">
            {PROOF_POINTS.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-800 bg-stone-900">
                  <Icon className="size-4 text-amber-500" aria-hidden />
                </span>
                <span className="text-sm text-stone-200">{label}</span>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex flex-1 items-center justify-center p-6 md:w-1/2">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-2.5 md:hidden">
            <div className="flex size-8 items-center justify-center rounded-lg bg-amber-500">
              <HardHat className="size-4 text-stone-950" aria-hidden />
            </div>
            <span className="text-lg font-semibold tracking-tight text-stone-900">
              Mjengo<span className="text-amber-600">OS</span>
            </span>
          </div>

          <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm sm:p-8">
            {mode === 'login' ? (
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault()
                  clearError()
                  if (canLogin) login.mutate()
                }}
                className="space-y-4"
              >
                <div className="space-y-1">
                  <h1 className="text-xl font-semibold tracking-tight text-stone-900">Sign in</h1>
                  <p className="text-sm text-stone-500">
                    Welcome back. Enter your details to continue.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-email">Email</Label>
                  <Input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      clearError()
                    }}
                    className="h-11"
                    disabled={pending}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="login-password">Password</Label>
                  <Input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      clearError()
                    }}
                    className="h-11"
                    disabled={pending}
                    required
                  />
                </div>
                {error && (
                  <p role="alert" className="text-sm font-medium text-red-600">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  className="h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600"
                  disabled={!canLogin || pending}
                >
                  {login.isPending && <Loader2 className="animate-spin" aria-hidden />} Sign in
                </Button>
                <p className="text-center text-sm text-stone-500">
                  New to MjengoOS?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('register')}
                    className="font-medium text-amber-700 underline-offset-4 hover:underline"
                    disabled={pending}
                  >
                    Create an organization
                  </button>
                </p>
              </form>
            ) : (
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault()
                  clearError()
                  if (canRegister) register.mutate()
                }}
                className="space-y-4"
              >
                <div className="space-y-1">
                  <h1 className="text-xl font-semibold tracking-tight text-stone-900">
                    Create your organization
                  </h1>
                  <p className="text-sm text-stone-500">
                    Set up MjengoOS for your construction business.
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-name">Your name</Label>
                  <Input
                    id="register-name"
                    autoComplete="name"
                    placeholder="e.g. Amina Yusuf"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value)
                      clearError()
                    }}
                    className="h-11"
                    disabled={pending}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-org">Organization name</Label>
                  <Input
                    id="register-org"
                    autoComplete="organization"
                    placeholder="e.g. Mjengo Builders Ltd"
                    value={organizationName}
                    onChange={(e) => {
                      setOrganizationName(e.target.value)
                      clearError()
                    }}
                    className="h-11"
                    disabled={pending}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-email">Email</Label>
                  <Input
                    id="register-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      clearError()
                    }}
                    className="h-11"
                    disabled={pending}
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="register-password">Password</Label>
                  <Input
                    id="register-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                      clearError()
                    }}
                    className="h-11"
                    disabled={pending}
                    required
                    minLength={8}
                  />
                  <p className="text-xs text-stone-500">At least 8 characters.</p>
                </div>
                {error && (
                  <p role="alert" className="text-sm font-medium text-red-600">
                    {error}
                  </p>
                )}
                <Button
                  type="submit"
                  className="h-11 w-full bg-amber-500 text-stone-950 hover:bg-amber-600"
                  disabled={!canRegister || pending}
                >
                  {register.isPending && <Loader2 className="animate-spin" aria-hidden />} Create
                  organization
                </Button>
                <p className="text-center text-sm text-stone-500">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => switchMode('login')}
                    className="font-medium text-amber-700 underline-offset-4 hover:underline"
                    disabled={pending}
                  >
                    Sign in
                  </button>
                </p>
              </form>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}
