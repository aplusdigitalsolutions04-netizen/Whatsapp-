import { NavLink } from "react-router";
import { FileArchive, ImagePlus, Store } from "lucide-react";

/** Three ways to work with product photos: edit files from this computer, edit photos already in Shopify, or bulk-upload a ZIP by SKU. */
export function ImageTabs({ active }: { active: "upload" | "store" | "bulk" }) {
  return (
    <div className="ie-tabs" role="tablist" aria-label="Image Editor">
      <NavLink role="tab" aria-selected={active === "upload"} className={active === "upload" ? "on" : ""} to="/app/image-editor"><ImagePlus size={15} /> Editor</NavLink>
      <NavLink role="tab" aria-selected={active === "store"} className={active === "store" ? "on" : ""} to="/app/image-products"><Store size={15} /> Store products</NavLink>
      <NavLink role="tab" aria-selected={active === "bulk"} className={active === "bulk" ? "on" : ""} to="/app/image-bulk"><FileArchive size={15} /> Bulk upload (ZIP)</NavLink>
    </div>
  );
}
