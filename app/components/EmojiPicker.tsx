import { useState } from "react";

const GROUPS: { label: string; emojis: string[] }[] = [
  { label: "😀", emojis: "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤩 🥳 🤗 🤔 😐 😴 😢 😭 😡 🥺 😮 😱 🙏".split(" ") },
  { label: "👍", emojis: "👍 👎 👌 ✌️ 🤝 👏 🙌 💪 👋 🤞 ☝️ 👉 👈 ✅ ❌ ⚠️ ❗ ❓ 💯 🔥 ⭐ ✨ 🎉 🎁 ❤️ 💙 💚 🧡 💛 💜".split(" ") },
  { label: "📦", emojis: "📦 🚚 🛒 🛍️ 💳 💰 🧾 📄 📎 📷 🖨️ 💻 🖥️ ⌨️ 🖱️ 💾 🔌 🔋 📱 ☎️ 📞 📧 📍 🏠 🏢 ⏰ 📅 🔎 🔗 🙂".split(" ") },
];

/** Small emoji popover; calls onPick with the chosen emoji. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(0);
  return (
    <span className="o-emoji">
      <button type="button" className="o-icon" aria-label="Insert emoji" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        😊
      </button>
      {open && (
        <div className="o-emoji-pop" role="dialog" aria-label="Emoji picker">
          <div className="o-emoji-tabs">
            {GROUPS.map((g, i) => (
              <button type="button" key={g.label} className={i === group ? "on" : ""} onClick={() => setGroup(i)} aria-label={`Emoji group ${i + 1}`}>
                {g.label}
              </button>
            ))}
          </div>
          <div className="o-emoji-grid">
            {GROUPS[group].emojis.map((e) => (
              <button type="button" key={e} onClick={() => onPick(e)}>
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </span>
  );
}
