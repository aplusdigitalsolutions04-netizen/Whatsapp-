import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { DEFAULT_MODEL } from "../lib/ai-models";
import { clearAiKey, getAiPublicState, saveAiConfig, testAiKey } from "../lib/ai.server";
import { getSettings, saveSettings } from "../lib/settings.server";
import { EDITABLE_TEMPLATES } from "../lib/templates";
import { Badge, Card, Page } from "../components/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { settings: await getSettings(session.shop), shop: session.shop, ai: await getAiPublicState(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "settings");
  if (intent === "ai_save") {
    try {
      await saveAiConfig(session.shop, form);
      return { ok: true, message: "AI settings saved." };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
  if (intent === "ai_clear") {
    await clearAiKey(session.shop);
    return { ok: true, message: "API key removed. The bot keeps working without AI." };
  }
  if (intent === "ai_test") {
    const r = await testAiKey(session.shop);
    return r.ok ? { ok: true, message: "API key works." } : { ok: false, message: `Test failed: ${r.error}` };
  }
  await saveSettings(session.shop, form);
  return { ok: true, message: "Settings saved" };
};

export default function Settings() {
  const { settings, shop, ai } = useLoaderData<typeof loader>();
  const saved = useActionData<typeof action>();
  const saving = useNavigation().state === "submitting";
  const shopify = useAppBridge();

  useEffect(() => {
    if (saved?.message) shopify.toast.show(saved.message, { isError: !saved.ok });
  }, [saved, shopify]);

  return (
    <Page title="Settings">
      <Form method="post">
        <Card title="Bot">
          <p><label><input type="checkbox" name="enabled" defaultChecked={settings.enabled} /> Enable automated replies</label></p>
          <p>
            <label>Max order verification attempts{" "}
              <input type="number" name="maxVerifyAttempts" min={1} max={10} defaultValue={settings.maxVerifyAttempts} />
            </label>{" "}
            <small>After this many failures the chat is handed to a human.</small>
          </p>
          <p><label><input type="checkbox" name="recommendationsEnabled" defaultChecked={settings.recommendationsEnabled} /> Send product recommendations</label></p>
          <p>
            <label>Max recommendations per reply{" "}
              <input type="number" name="maxRecommendations" min={1} max={5} defaultValue={settings.maxRecommendations} />
            </label>
          </p>
          <p>
            <label>Recommend products that share the same{" "}
              <select name="recommendationRule" defaultValue={settings.recommendationRule}>
                <option value="productType">product type</option>
                <option value="tag">first tag</option>
              </select>
            </label>
          </p>
        </Card>

        <Card title="Customer-facing messages (English)">
          <p className="o-muted">Hindi replies use built-in translations. Edit questions and answers on the Quick replies page.</p>
          {EDITABLE_TEMPLATES.map((k) => (
            <label key={k} className="o-field">
              <span>{k}</span>
              <textarea name={`tpl_${k}`} rows={2} maxLength={1000} defaultValue={settings.templates[k]} />
            </label>
          ))}
        </Card>

        <Card title="Store">
          <p className="o-p">Shopify store: <strong>{shop}</strong>. Connection tests and WhatsApp credentials are on the Integrations page.</p>
          <button type="submit" disabled={saving}>{saving ? "Saving…" : "Save settings"}</button>
        </Card>
      </Form>
      <Card title="AI replies (optional)">
        <p className="o-p">
          The bot works fully without this. If you add an API key, questions that no quick reply or order flow can answer
          are sent to the AI, which may only use your Quick replies as facts. If the AI is off, fails or is unsure, the bot
          falls back to its normal reply or hands over to a human.
        </p>
        {ai.keySet || ai.envKey ? (
          <p className="o-p"><Badge tone="success">Key saved {ai.keyHint ?? "(from environment)"}</Badge></p>
        ) : (
          <p className="o-p"><Badge>No key: AI is off</Badge></p>
        )}
        <Form method="post">
          <input type="hidden" name="intent" value="ai_save" />
          <label className="o-field">
            <span>Provider</span>
            <select name="aiProvider" defaultValue={ai.provider}>
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic (Claude)</option>
            </select>
          </label>
          <label className="o-field">
            <span>Model (leave empty for default: OpenAI {DEFAULT_MODEL.openai}, Claude {DEFAULT_MODEL.anthropic})</span>
            <input name="aiModel" defaultValue={ai.model} maxLength={80} autoComplete="off" />
          </label>
          <label className="o-field">
            <span>API key {ai.keySet ? "(leave empty to keep the saved key)" : ""}</span>
            <input name="aiKey" type="password" autoComplete="new-password" spellCheck={false} placeholder={ai.keyHint ?? "sk-..."} style={{ width: "100%" }} />
          </label>
          <p><label><input type="checkbox" name="aiEnabled" defaultChecked={ai.enabled} /> Use AI for questions the bot can&apos;t answer</label></p>
          <div className="o-row">
            <button type="submit" disabled={saving}>Save AI settings</button>
          </div>
        </Form>
        <div className="o-row" style={{ marginTop: 10 }}>
          <Form method="post"><input type="hidden" name="intent" value="ai_test" /><button className="ghost" disabled={!ai.keySet && !ai.envKey}>Test key</button></Form>
          <Form
            method="post"
            onSubmit={(e) => {
              if (!window.confirm("Remove the saved API key and turn AI off?")) e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="ai_clear" />
            <button className="danger" disabled={!ai.keySet}>Remove key</button>
          </Form>
        </div>
        <p className="o-muted">The key is encrypted on the server and never shown again. Customer questions sent to the AI leave your server for that provider.</p>
      </Card>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
