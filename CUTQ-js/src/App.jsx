import { Toaster } from "sonner";
import { firebaseConfigured } from "./firebase.js";
import AdminAuth from "./pages/admin/AdminAuth.jsx";

function App() {
  if (!firebaseConfigured) {
    return (
      <>
        <div className="min-h-screen bg-[#0a0a0a] text-white flex items-center justify-center p-6">
          <div className="w-full max-w-2xl rounded-xl border border-white/10 bg-white/5 p-6">
            <h1 className="text-lg font-semibold">Firebase not configured</h1>
            <p className="mt-2 text-sm text-gray-300">
              Create a <code className="text-gray-100">CUTQ-js/.env</code> file with your Firebase keys (must start with{" "}
              <code className="text-gray-100">VITE_</code>), then restart <code className="text-gray-100">npm run dev</code>.
            </p>
            <pre className="mt-4 text-xs bg-black/40 border border-white/10 rounded p-3 overflow-auto text-gray-200">
{`VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_STORAGE_BUCKET=...
VITE_FIREBASE_MESSAGING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...`}
            </pre>
          </div>
        </div>
        <Toaster position="top-right" />
      </>
    );
  }
  return (
    <>
      <AdminAuth />
      <Toaster position="top-right" />
    </>
  );
}

export default App;