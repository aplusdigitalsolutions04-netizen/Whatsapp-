import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { Badge, Card, Page } from "../components/ui";

const SITE = "https://wery.in";

// Starter entries that only contain facts we know (the website address). Policies, prices and
// timings are deliberately left for the store owner to add.
const STARTERS = [
  {
    title: "Website",
    keywords: "website, web site, site, link, url, wery.in, online store, shop online, वेबसाइट, साइट, लिंक, वेबसाइट लिंक",
    replyEn: `You can visit our website here: ${SITE}`,
    replyHi: `आप हमारी वेबसाइट यहाँ देख सकते हैं: ${SITE}`,
  },
  {
    title: "Browse products",
    keywords: "catalog, catalogue, collection, all products, products list, कैटलॉग, सभी प्रोडक्ट, प्रोडक्ट लिस्ट",
    replyEn: `You can browse all our products on ${SITE}`,
    replyHi: `हमारे सभी प्रोडक्ट आप ${SITE} पर देख सकते हैं।`,
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  if ((await prisma.faq.count({ where: { shop } })) === 0) {
    await prisma.faq.createMany({ data: STARTERS.map((f) => ({ ...f, shop })) });
  }
  const faqs = await prisma.faq.findMany({ where: { shop }, orderBy: { createdAt: "asc" } });
  return { faqs };
};

const clip = (v: FormDataEntryValue | null, max: number) => String(v ?? "").trim().slice(0, max);

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = clip(form.get("id"), 40);

  if (intent === "delete") {
    await prisma.faq.deleteMany({ where: { id, shop } });
    return { ok: true, message: "Quick reply deleted." };
  }
  if (intent === "toggle") {
    const f = await prisma.faq.findFirst({ where: { id, shop } });
    if (f) await prisma.faq.update({ where: { id }, data: { enabled: !f.enabled } });
    return { ok: true, message: f?.enabled ? "Turned off." : "Turned on." };
  }

  const data = {
    title: clip(form.get("title"), 80),
    keywords: clip(form.get("keywords"), 200000),
    replyEn: clip(form.get("replyEn"), 1500),
    replyHi: clip(form.get("replyHi"), 1500),
    replyHinglish: clip(form.get("replyHinglish"), 1500),
    questions: clip(form.get("questions"), 20000),
  };
  const anyReply = !!(data.replyEn || data.replyHi || data.replyHinglish);
  if (!data.title || (!data.keywords && !data.questions)) {
    return { ok: false, message: "Add a title and at least one keyword or question." };
  }
  if (intent === "create") {
    if (!anyReply) return { ok: false, message: "Add a reply." };
    await prisma.faq.create({ data: { ...data, shop } });
    return { ok: true, message: "Quick reply added.", reset: true };
  }
  if (intent === "update") {
    const prev = await prisma.faq.findFirst({ where: { id, shop } });
    const hasReply = anyReply;
    // Entries seeded without an answer stay off until a real reply is saved, then switch on.
    const turnOn = !!prev && !prev.enabled && !prev.replyEn && !prev.replyHi && !prev.replyHinglish && hasReply;
    await prisma.faq.updateMany({ where: { id, shop }, data: { ...data, ...(turnOn ? { enabled: true } : {}) } });
    return { ok: true, message: turnOn ? "Saved and turned on." : "Saved." };
  }
  return { ok: false, message: "Unknown action" };
};

type Faq = { id?: string; title: string; keywords: string; questions: string; replyEn: string; replyHi: string; replyHinglish: string; enabled?: boolean };

function FaqForm({ faq, busy }: { faq?: Faq; busy: boolean }) {
  const editing = !!faq?.id;
  return (
    <Form method="post" key={faq?.id ?? "new"}>
      {editing && <input type="hidden" name="id" value={faq!.id} />}
      <label className="o-field">
        <span>Title (for you only)</span>
        <input name="title" defaultValue={faq?.title} required maxLength={80} style={{ width: "100%" }} />
      </label>
      <label className="o-field">
        <span>Keywords: sent when the message contains any of these (comma separated; English, Hindi or Hinglish)</span>
        <textarea name="keywords" rows={faq?.keywords && faq.keywords.length > 300 ? 6 : 2} defaultValue={faq?.keywords} />
      </label>
      <label className="o-field">
        <span>Questions, one per line (matched even if the customer words it differently)</span>
        <textarea name="questions" rows={faq?.questions && faq.questions.length > 200 ? 5 : 3} defaultValue={faq?.questions} />
      </label>
      <label className="o-field">
        <span>Reply in English</span>
        <textarea name="replyEn" rows={3} defaultValue={faq?.replyEn} maxLength={1500} />
      </label>
      <label className="o-field">
        <span>Reply in Hinglish (Hindi in English letters: for customers who type like &quot;mera order kahan hai&quot;)</span>
        <textarea name="replyHinglish" rows={3} defaultValue={faq?.replyHinglish} maxLength={1500} />
      </label>
      <label className="o-field">
        <span>Reply in Hindi (हिंदी)</span>
        <textarea name="replyHi" rows={3} defaultValue={faq?.replyHi} maxLength={1500} />
      </label>
      <div className="o-row">
        <button name="intent" value={editing ? "update" : "create"} disabled={busy}>{editing ? "Save" : "Add quick reply"}</button>
        {editing && (
          <>
            <button className="ghost" name="intent" value="toggle" disabled={busy} formNoValidate>
              {faq!.enabled ? "Turn off" : "Turn on"}
            </button>
            <button
              className="danger"
              name="intent"
              value="delete"
              disabled={busy}
              formNoValidate
              onClick={(e) => {
                if (!window.confirm("Delete this quick reply?")) e.preventDefault();
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>
    </Form>
  );
}

export default function QuickReplies() {
  const { faqs } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const busy = useNavigation().state !== "idle";
  const shopify = useAppBridge();

  useEffect(() => {
    if (result?.message) shopify.toast.show(result.message, { isError: !result.ok });
  }, [result, shopify]);

  return (
    <Page
      title="Quick replies"
      subtitle="Predefined answers the bot sends instantly. It replies in the language the customer writes in."
    >
      <Card title="Add a quick reply">
        <FaqForm key={result?.ok && "reset" in result ? Date.now() : "new"} busy={busy} />
      </Card>
      {faqs.length === 0 && <p className="o-p">No quick replies yet.</p>}
      {faqs.map((f) => (
        <Card key={f.id} title={f.title}>
          <p className="o-p">
            {!f.enabled && <Badge tone="warning">{!f.replyEn && !f.replyHi && !f.replyHinglish ? "Off: needs your answer" : "Off"}</Badge>}{" "}
            <small>{f.keywords ? f.keywords.split(",").length : 0} phrases · {f.questions ? f.questions.split("\n").length : 0} questions</small>
          </p>
          <FaqForm faq={f} busy={busy} />
        </Card>
      ))}
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
