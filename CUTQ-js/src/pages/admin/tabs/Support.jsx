import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Link from "@tiptap/extension-link";
import {
  listenSupportContact,
  saveSupportContact,
  listenSupportFaqs,
  saveSupportFaqs,
  listenPrivacyPolicy,
  savePrivacyPolicy,
} from "../../../lib/adminFirestore";

// ─── Main Support Tab ─────────────────────────────────────────────────────────

export default function Support() {
  const [section, setSection] = useState("contact");

  const sections = [
    { id: "contact", label: "Contact Info" },
    { id: "faqs",    label: "FAQs" },
    { id: "policy",  label: "Privacy Policy" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Support Management</h2>
        <p className="text-sm text-gray-400 mt-1">
          Manage app support content — all changes reflect immediately in the user app.
        </p>
      </div>

      {/* Sub-nav */}
      <div className="flex gap-1 border-b border-white/10 pb-0">
        {sections.map(s => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors -mb-px ${
              section === s.id
                ? "bg-[#18B79B]/15 text-[#18B79B] border-b-2 border-[#18B79B]"
                : "text-gray-400 hover:text-white"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="pt-2">
        {section === "contact" && <ContactSection />}
        {section === "faqs"    && <FaqsSection />}
        {section === "policy"  && <PolicySection />}
      </div>
    </div>
  );
}

// ─── Contact Section ──────────────────────────────────────────────────────────

function ContactSection() {
  const [data, setData]     = useState({ email: "", phone: "", support_hours: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const unsub = listenSupportContact(d => setData(d));
    return unsub;
  }, []);

  async function handleSave() {
    if (!data.email.trim() || !data.phone.trim()) {
      toast.error("Email and phone are required");
      return;
    }
    setSaving(true);
    try {
      await saveSupportContact(data);
      toast.success("Contact info saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-lg space-y-5">
      <p className="text-sm text-gray-400">
        This contact info is shown to users in the "Contact Support" screen of the app.
      </p>

      <Field label="Support Email" required>
        <input
          type="email"
          value={data.email}
          onChange={e => setData(d => ({ ...d, email: e.target.value }))}
          placeholder="connect@cutq.store"
          className={inputCls}
        />
      </Field>

      <Field label="Support Phone" required>
        <input
          type="tel"
          value={data.phone}
          onChange={e => setData(d => ({ ...d, phone: e.target.value }))}
          placeholder="+91 9588561910"
          className={inputCls}
        />
      </Field>

      <Field label="Support Hours">
        <input
          type="text"
          value={data.support_hours}
          onChange={e => setData(d => ({ ...d, support_hours: e.target.value }))}
          placeholder="Mon–Sat, 9 AM – 7 PM IST"
          className={inputCls}
        />
      </Field>

      <button onClick={handleSave} disabled={saving} className={btnCls}>
        {saving ? "Saving…" : "Save Contact Info"}
      </button>
    </div>
  );
}

// ─── FAQs Section ─────────────────────────────────────────────────────────────

function FaqsSection() {
  const [items, setItems]   = useState([]);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft]   = useState({ question: "", answer: "" });

  useEffect(() => {
    const unsub = listenSupportFaqs(d => setItems(d.items ?? []));
    return unsub;
  }, []);

  function makeId() {
    return `faq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function startAdd() {
    setEditingId("__new__");
    setDraft({ question: "", answer: "" });
  }

  function startEdit(item) {
    setEditingId(item.id);
    setDraft({ question: item.question, answer: item.answer });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft({ question: "", answer: "" });
  }

  async function saveEdit() {
    if (!draft.question.trim() || !draft.answer.trim()) {
      toast.error("Question and answer are required");
      return;
    }
    let updated;
    if (editingId === "__new__") {
      const newItem = { id: makeId(), question: draft.question.trim(), answer: draft.answer.trim(), order: items.length };
      updated = [...items, newItem];
    } else {
      updated = items.map(i => i.id === editingId ? { ...i, question: draft.question.trim(), answer: draft.answer.trim() } : i);
    }
    setSaving(true);
    try {
      await saveSupportFaqs(updated);
      setItems(updated);
      cancelEdit();
      toast.success(editingId === "__new__" ? "FAQ added" : "FAQ updated");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem(id) {
    const updated = items.filter(i => i.id !== id).map((i, idx) => ({ ...i, order: idx }));
    setSaving(true);
    try {
      await saveSupportFaqs(updated);
      setItems(updated);
      toast.success("FAQ deleted");
    } catch {
      toast.error("Failed to delete");
    } finally {
      setSaving(false);
    }
  }

  async function moveItem(id, dir) {
    const idx = items.findIndex(i => i.id === id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= items.length) return;
    const updated = [...items];
    [updated[idx], updated[newIdx]] = [updated[newIdx], updated[idx]];
    const reordered = updated.map((i, o) => ({ ...i, order: o }));
    setSaving(true);
    try {
      await saveSupportFaqs(reordered);
      setItems(reordered);
    } catch {
      toast.error("Failed to reorder");
    } finally {
      setSaving(false);
    }
  }

  const sorted = [...items].sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">
          These FAQs appear in the "Help Centre" screen. Drag or use arrows to reorder.
        </p>
        {editingId === null && (
          <button onClick={startAdd} className={btnCls + " !py-1.5 !px-4 !text-xs"}>
            + Add FAQ
          </button>
        )}
      </div>

      {/* Inline editor */}
      {editingId !== null && (
        <div className="rounded-xl border border-[#18B79B]/40 bg-[#18B79B]/5 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-[#18B79B]">
            {editingId === "__new__" ? "New FAQ" : "Edit FAQ"}
          </h4>
          <Field label="Question" required>
            <input
              type="text"
              value={draft.question}
              onChange={e => setDraft(d => ({ ...d, question: e.target.value }))}
              placeholder="What is CutQ?"
              className={inputCls}
            />
          </Field>
          <Field label="Answer" required>
            <textarea
              value={draft.answer}
              onChange={e => setDraft(d => ({ ...d, answer: e.target.value }))}
              placeholder="CutQ is a salon booking platform…"
              rows={4}
              className={inputCls + " resize-none"}
            />
          </Field>
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={saving} className={btnCls + " !py-1.5 !px-4 !text-xs"}>
              {saving ? "Saving…" : editingId === "__new__" ? "Add FAQ" : "Update FAQ"}
            </button>
            <button onClick={cancelEdit} className="px-4 py-1.5 text-xs rounded text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* FAQ list */}
      <div className="space-y-2">
        {sorted.length === 0 && editingId === null && (
          <p className="text-sm text-gray-500 py-6 text-center">No FAQs yet. Add your first one.</p>
        )}
        {sorted.map((item, idx) => (
          <div key={item.id} className="flex gap-3 items-start rounded-xl border border-white/10 bg-white/5 p-4">
            {/* Reorder arrows */}
            <div className="flex flex-col gap-0.5 pt-0.5 shrink-0">
              <button onClick={() => moveItem(item.id, -1)} disabled={idx === 0 || saving}
                className="text-gray-500 hover:text-white disabled:opacity-20 text-xs leading-none">▲</button>
              <button onClick={() => moveItem(item.id, 1)} disabled={idx === sorted.length - 1 || saving}
                className="text-gray-500 hover:text-white disabled:opacity-20 text-xs leading-none">▼</button>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white leading-snug">{item.question}</p>
              <p className="text-xs text-gray-400 mt-1 leading-relaxed line-clamp-2">{item.answer}</p>
            </div>
            <div className="flex gap-1 shrink-0">
              <button onClick={() => startEdit(item)} disabled={editingId !== null}
                className="px-2.5 py-1 text-xs rounded bg-white/10 text-gray-300 hover:bg-white/20 disabled:opacity-30 transition-colors">
                Edit
              </button>
              <button onClick={() => deleteItem(item.id)} disabled={saving || editingId !== null}
                className="px-2.5 py-1 text-xs rounded bg-red-500/15 text-red-400 hover:bg-red-500/25 disabled:opacity-30 transition-colors">
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Privacy Policy Section ───────────────────────────────────────────────────

function PolicySection() {
  const [policyType, setPolicyType] = useState("user");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-sm text-gray-400">Editing policy for:</span>
        <div className="flex rounded-lg border border-white/10 overflow-hidden">
          {[["user", "User App"], ["salon", "Salon Dashboard"]].map(([type, label]) => (
            <button
              key={type}
              onClick={() => setPolicyType(type)}
              className={`px-4 py-1.5 text-sm transition-colors ${
                policyType === type
                  ? "bg-[#18B79B] text-white font-medium"
                  : "text-gray-400 hover:text-white bg-transparent"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {policyType === "user" && (
          <span className="text-xs text-gray-500 bg-white/5 rounded px-2 py-1">Shown in user app</span>
        )}
        {policyType === "salon" && (
          <span className="text-xs text-gray-500 bg-white/5 rounded px-2 py-1">Shown in salon dashboard</span>
        )}
      </div>

      <PolicyEditor key={policyType} type={policyType} />
    </div>
  );
}

function PolicyEditor({ type }) {
  const [saving, setSaving]   = useState(false);
  const [loaded, setLoaded]   = useState(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Link.configure({ openOnClick: false }),
    ],
    content: "",
    editorProps: {
      attributes: {
        class: "prose prose-invert max-w-none min-h-[420px] px-5 py-4 focus:outline-none text-sm leading-relaxed",
      },
    },
  });

  // Load from Firestore
  useEffect(() => {
    const unsub = listenPrivacyPolicy(type, ({ html }) => {
      if (!loaded && editor && html) {
        editor.commands.setContent(html);
        setLoaded(true);
      }
    });
    return unsub;
  }, [type, editor, loaded]);

  async function handleSave() {
    if (!editor) return;
    const html = editor.getHTML();
    if (!html || html === "<p></p>") {
      toast.error("Policy content cannot be empty");
      return;
    }
    setSaving(true);
    try {
      await savePrivacyPolicy(type, html);
      toast.success(`${type === "user" ? "User" : "Salon"} privacy policy saved`);
    } catch {
      toast.error("Failed to save policy");
    } finally {
      setSaving(false);
    }
  }

  if (!editor) return null;

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-400">
        Write your policy using the rich text editor below. The content is saved as HTML and
        displayed in a web view inside the app — formatting is fully preserved.
      </p>

      <div className="rounded-xl border border-white/10 overflow-hidden bg-[#111]">
        {/* Toolbar */}
        <EditorToolbar editor={editor} />

        {/* Editor area */}
        <div className="min-h-[420px] text-white">
          <EditorContent editor={editor} />
        </div>
      </div>

      {/* Word count + save */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">
          {editor.storage.characterCount?.characters?.() ?? ""} characters
        </span>
        <button onClick={handleSave} disabled={saving} className={btnCls}>
          {saving ? "Saving…" : `Save ${type === "user" ? "User" : "Salon"} Policy`}
        </button>
      </div>
    </div>
  );
}

// ─── Rich Text Editor Toolbar ─────────────────────────────────────────────────

function EditorToolbar({ editor }) {
  const setLink = useCallback(() => {
    const prev = editor.getAttributes("link").href;
    const url  = window.prompt("URL", prev ?? "https://");
    if (url === null) return;
    if (url === "") { editor.chain().focus().extendMarkRange("link").unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const ToolBtn = ({ onClick, active, title, children, disabled }) => (
    <button
      onMouseDown={e => { e.preventDefault(); onClick(); }}
      disabled={disabled}
      title={title}
      className={`w-8 h-8 flex items-center justify-center rounded text-sm transition-colors
        ${active ? "bg-[#18B79B]/25 text-[#18B79B]" : "text-gray-400 hover:text-white hover:bg-white/10"}
        disabled:opacity-30`}
    >
      {children}
    </button>
  );

  const Sep = () => <div className="w-px h-5 bg-white/10 mx-1" />;

  return (
    <div className="flex flex-wrap items-center gap-0.5 px-3 py-2 border-b border-white/10 bg-[#0d0d0d]">
      {/* Heading levels */}
      {[1, 2, 3].map(level => (
        <ToolBtn key={level}
          onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          active={editor.isActive("heading", { level })}
          title={`Heading ${level}`}>
          H{level}
        </ToolBtn>
      ))}
      <Sep />

      {/* Inline marks */}
      <ToolBtn onClick={() => editor.chain().focus().toggleBold().run()}      active={editor.isActive("bold")}      title="Bold">        <b>B</b></ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().toggleItalic().run()}    active={editor.isActive("italic")}    title="Italic">      <i>I</i></ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Underline">   <u>U</u></ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().toggleStrike().run()}    active={editor.isActive("strike")}    title="Strikethrough"><s>S</s></ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().toggleCode().run()}      active={editor.isActive("code")}      title="Inline code">  <code className="text-xs">{"<>"}</code></ToolBtn>
      <Sep />

      {/* Alignment */}
      <ToolBtn onClick={() => editor.chain().focus().setTextAlign("left").run()}    active={editor.isActive({ textAlign: "left" })}    title="Align left">   ≡</ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().setTextAlign("center").run()}  active={editor.isActive({ textAlign: "center" })}  title="Align center"> ≡</ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().setTextAlign("right").run()}   active={editor.isActive({ textAlign: "right" })}   title="Align right">  ≡</ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().setTextAlign("justify").run()} active={editor.isActive({ textAlign: "justify" })} title="Justify">      ≡</ToolBtn>
      <Sep />

      {/* Lists */}
      <ToolBtn onClick={() => editor.chain().focus().toggleBulletList().run()}  active={editor.isActive("bulletList")}  title="Bullet list"> •≡</ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Numbered list">1≡</ToolBtn>
      <Sep />

      {/* Block elements */}
      <ToolBtn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive("blockquote")} title="Blockquote"> ❝</ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal rule"> ─</ToolBtn>
      <Sep />

      {/* Link */}
      <ToolBtn onClick={setLink} active={editor.isActive("link")} title="Link"> 🔗</ToolBtn>
      <Sep />

      {/* Color */}
      <label title="Text color" className="w-8 h-8 flex items-center justify-center rounded cursor-pointer hover:bg-white/10">
        <span className="text-sm" style={{ color: editor.getAttributes("textStyle").color ?? "#fff" }}>A</span>
        <input type="color" className="sr-only"
          value={editor.getAttributes("textStyle").color ?? "#ffffff"}
          onChange={e => editor.chain().focus().setColor(e.target.value).run()} />
      </label>
      <ToolBtn onClick={() => editor.chain().focus().unsetColor().run()} title="Remove color"> ✕</ToolBtn>
      <Sep />

      {/* Undo / Redo */}
      <ToolBtn onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="Undo"> ↩</ToolBtn>
      <ToolBtn onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="Redo"> ↪</ToolBtn>
    </div>
  );
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

const inputCls = "w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-[#18B79B]/60 transition-colors";
const btnCls   = "px-5 py-2 text-sm font-medium rounded-lg bg-[#18B79B] text-white hover:bg-[#15a389] disabled:opacity-40 transition-colors";

function Field({ label, required, children }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-medium text-gray-300">
        {label} {required && <span className="text-red-400">*</span>}
      </label>
      {children}
    </div>
  );
}
