import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { PlusIcon, Trash2, ImageIcon } from "lucide-react";
import { listenHeaderImages, addHeaderImage, removeHeaderImage } from "../../../lib/adminFirestore";

export default function HeaderImages() {
  const [images, setImages] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    const unsub = listenHeaderImages(data => {
      setImages(data.images || []);
    });
    return unsub;
  }, []);

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    try {
      await addHeaderImage(file);
      toast.success("Header image added");
    } catch {
      toast.error("Failed to upload image");
    } finally {
      setUploading(false);
    }
  }

  async function handleRemove(item) {
    if (!confirm("Remove this header image?")) return;
    try {
      await removeHeaderImage(item);
      toast.success("Image removed");
    } catch {
      toast.error("Failed to remove image");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Header Images</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Images shown in the app header carousel — stored in{" "}
            <code className="text-gray-400">app_config/header</code>
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-[#18B79B] text-white rounded hover:bg-[#15a389] disabled:opacity-50 transition-colors"
        >
          {uploading ? (
            <>
              <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Uploading…
            </>
          ) : (
            <>
              <PlusIcon size={14} />
              Add Image
            </>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      {images.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 rounded-xl border border-dashed border-white/10 text-gray-600">
          <ImageIcon size={32} />
          <p className="text-sm">No header images yet. Add one to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
          {images.map((item, idx) => (
            <div
              key={item.id}
              className="group relative rounded-lg overflow-hidden border border-white/10 bg-white/5 aspect-video"
            >
              <img
                src={item.url}
                alt={`Header image ${idx + 1}`}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-start justify-end p-2 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => handleRemove(item)}
                  className="p-1.5 rounded bg-red-500/80 hover:bg-red-500 text-white transition-colors"
                  title="Remove image"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="absolute bottom-1.5 left-2 text-[10px] text-white/60 bg-black/50 rounded px-1">
                #{idx + 1}
              </div>
            </div>
          ))}
        </div>
      )}

      {images.length > 0 && (
        <p className="text-xs text-gray-600">
          {images.length} image{images.length !== 1 ? "s" : ""} · Hover an image to remove it
        </p>
      )}
    </div>
  );
}
