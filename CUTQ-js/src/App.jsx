import { Toaster } from "sonner";
import Home from "./pages/Home";

function App() {
  return (
    <>
      <Home />
      <Toaster
        position="top-right"
        toastOptions={{
          classNames: {
            toast: "bg-[var(--primary)] border border-border text-foreground",
            title: "text-[var(--accent)]",
            description: "text-muted-foreground",
          },
        }}
      />
    </>
  );
}

export default App;
