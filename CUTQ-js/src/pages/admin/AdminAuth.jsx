import { useEffect, useMemo, useState } from "react";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { toast } from "sonner";
import AdminPanel from "./AdminPanel";
import { auth, db } from "../../firebase";

async function getUserProfile(uid) {
  const candidates = ["Users", "users"];
  for (const col of candidates) {
    const snap = await getDoc(doc(db, col, uid));
    if (snap.exists()) return { id: snap.id, ...snap.data() };
  }
  return null;
}

function isAdminEnabled(profile) {
  return profile?.Role === "ADMIN" && profile?.isEnabled === true;
}

function AuthCard({ children }) {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-6">
        {children}
      </div>
    </div>
  );
}

function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
      onSignedIn?.(cred.user);
    } catch (err) {
      console.error(err);
      toast.error("Sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard>
      <h1 className="text-lg font-semibold">Admin Sign In</h1>
      <p className="mt-1 text-sm text-gray-400">Only enabled admins can access this panel.</p>

      <form onSubmit={submit} className="mt-5 flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Email</label>
          <input
            value={email}
            onChange={e => setEmail(e.target.value)}
            type="email"
            autoComplete="email"
            className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]"
            placeholder="admin@example.com"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Password</label>
          <input
            value={password}
            onChange={e => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            className="bg-white/10 border border-white/10 rounded px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]"
            placeholder="••••••••"
          />
        </div>
        <button
          disabled={submitting || !email.trim() || !password}
          className="mt-2 px-4 py-2 text-sm rounded bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-50 transition-colors"
          type="submit"
        >
          {submitting ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </AuthCard>
  );
}

export default function AdminAuth() {
  const [authState, setAuthState] = useState({ status: "loading", user: null });
  const [checkingProfile, setCheckingProfile] = useState(false);
  const [profile, setProfile] = useState(null);

  const canAccess = useMemo(() => isAdminEnabled(profile), [profile]);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, user => {
      setProfile(null);
      setAuthState({ status: "ready", user: user || null });
    });
  }, []);

  useEffect(() => {
    async function run() {
      if (!authState.user) return;
      setCheckingProfile(true);
      try {
        const p = await getUserProfile(authState.user.uid);
        setProfile(p);
        if (!isAdminEnabled(p)) {
          await signOut(auth);
          toast.error("Access denied: admin not enabled");
        }
      } catch (err) {
        console.error(err);
        await signOut(auth);
        toast.error("Failed to verify admin access");
      } finally {
        setCheckingProfile(false);
      }
    }
    run();
  }, [authState.user]);

  if (authState.status === "loading") {
    return (
      <AuthCard>
        <p className="text-sm text-gray-300">Loading…</p>
      </AuthCard>
    );
  }

  if (!authState.user) {
    return <SignIn onSignedIn={() => {}} />;
  }

  if (checkingProfile) {
    return (
      <AuthCard>
        <p className="text-sm text-gray-300">Checking admin access…</p>
      </AuthCard>
    );
  }

  if (!canAccess) {
    return <SignIn onSignedIn={() => {}} />;
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="border-b border-white/10 px-6 py-2 flex items-center justify-between">
        <div className="text-xs text-gray-400">Signed in as <span className="text-gray-200">{authState.user.email}</span></div>
        <button
          onClick={() => signOut(auth)}
          className="text-xs px-3 py-1 rounded border border-white/10 text-gray-300 hover:bg-white/5"
        >
          Sign out
        </button>
      </div>
      <AdminPanel />
    </div>
  );
}

