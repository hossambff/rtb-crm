"use client";
import * as React from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, ColorTick, StatusBadge } from "@/components/ui/badge";
import { Input, NativeSelect, Textarea } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/misc";
import { AdminSection, AdminTable, ConfirmButton, Field, Switch, Td, Th, useAction } from "@/components/admin/form";
import { ChipMultiSelect } from "@/components/admin/fields-editor-controls";
import { parseJsonObject, PRICING_MODEL_LABELS, PRICING_MODELS, PRODUCT_STATUSES } from "@/lib/admin/config-schemas";
import { deleteProduct, saveProduct } from "@/lib/admin/products-actions";
import type { AdminProduct } from "@/lib/admin/config-queries";

type PipelineOpt = { key: string; name: string; color: string };
type ProductStatus = (typeof PRODUCT_STATUSES)[number];
type Pricing = (typeof PRICING_MODELS)[number];
const STATUS_LABEL: Record<ProductStatus, string> = { live: "Live", beta: "Beta", upcoming: "Upcoming", retired: "Retired" };

function ProductStatusBadge({ status }: { status: string }) {
  if (status === "live") return <StatusBadge status="good" label="Live" />;
  if (status === "beta") return <StatusBadge status="warning" label="Beta" />;
  return <Badge>{STATUS_LABEL[status as ProductStatus] ?? status}</Badge>;
}

export function ProductsEditor({ products, pipelines }: { products: AdminProduct[]; pipelines: PipelineOpt[] }) {
  const [editing, setEditing] = React.useState<AdminProduct | "new" | null>(null);
  const del = useAction(deleteProduct, { success: "Product deleted" });
  const colorOf = new Map(pipelines.map((p) => [p.key, p.color]));
  const families = Array.from(new Set(products.map((p) => p.family)));

  return (
    <AdminSection
      title="Product catalog"
      description="Products offered per pipeline, with pricing model, status and default terms (PRD §5). Beta/upcoming products are never presented as live."
      actions={
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus aria-hidden /> New product
        </Button>
      }
    >
      {products.length === 0 ? (
        <EmptyState title="No products" description="Add the first product to the catalog." />
      ) : (
        <div className="space-y-6">
          {families.map((family) => (
            <div key={family}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">{family}</h3>
              <AdminTable cards>
                <thead>
                  <tr>
                    <Th>Product</Th>
                    <Th>Pipelines</Th>
                    <Th>Pricing</Th>
                    <Th>Status</Th>
                    <Th>Default terms</Th>
                    <Th className="w-20">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {products
                    .filter((p) => p.family === family)
                    .map((p) => (
                      <tr key={p.id} className={p.active ? undefined : "opacity-60"}>
                        <Td label="Product" primary>
                          <div className="min-w-0">
                            <div className="font-medium text-fg">{p.name}</div>
                            <div className="text-xs text-muted">
                              {p.sku ?? "No SKU"}
                              {!p.active ? " · inactive" : ""}
                            </div>
                          </div>
                        </Td>
                        <Td label="Pipelines">
                          <div className="flex flex-wrap justify-end gap-2 text-xs md:justify-start">
                            {p.pipelineKeys.map((k) => (
                              <span key={k} className="inline-flex items-center gap-1">
                                <ColorTick color={colorOf.get(k) ?? "#828282"} />
                                {k}
                              </span>
                            ))}
                            {!p.pipelineKeys.length ? <span className="text-muted">—</span> : null}
                          </div>
                        </Td>
                        <Td label="Pricing" className="text-xs">{p.pricingModel ? (PRICING_MODEL_LABELS[p.pricingModel as Pricing] ?? p.pricingModel) : "—"}</Td>
                        <Td label="Status">
                          <ProductStatusBadge status={p.status} />
                        </Td>
                        <Td label="Default terms" className="truncate md:max-w-48 font-mono text-xs text-muted">{Object.keys(p.defaultTerms ?? {}).length ? JSON.stringify(p.defaultTerms) : "—"}</Td>
                        <Td actions>
                          <div className="flex justify-end gap-0.5">
                            <Button size="icon-sm" variant="ghost" aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
                              <Pencil aria-hidden />
                            </Button>
                            <ConfirmButton
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`Delete ${p.name}`}
                              title={`Delete "${p.name}"?`}
                              description="Products used on deals can't be deleted — mark them inactive or retired instead."
                              confirmLabel="Delete product"
                              onConfirm={() => del.run({ id: p.id })}
                            >
                              <Trash2 aria-hidden />
                            </ConfirmButton>
                          </div>
                        </Td>
                      </tr>
                    ))}
                </tbody>
              </AdminTable>
            </div>
          ))}
        </div>
      )}
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          {editing ? (
            <ProductForm product={editing === "new" ? null : editing} pipelines={pipelines} families={families} onDone={() => setEditing(null)} />
          ) : null}
        </DialogContent>
      </Dialog>
    </AdminSection>
  );
}

function ProductForm({ product, pipelines, families, onDone }: { product: AdminProduct | null; pipelines: PipelineOpt[]; families: string[]; onDone: () => void }) {
  const id = React.useId();
  const [family, setFamily] = React.useState(product?.family ?? "");
  const [name, setName] = React.useState(product?.name ?? "");
  const [sku, setSku] = React.useState(product?.sku ?? "");
  const [description, setDescription] = React.useState(product?.description ?? "");
  const [pipelineKeys, setPipelineKeys] = React.useState<string[]>(product?.pipelineKeys ?? []);
  const [pricingModel, setPricingModel] = React.useState<string>(product?.pricingModel ?? "");
  const [status, setStatus] = React.useState<ProductStatus>((product?.status as ProductStatus) ?? "live");
  const [active, setActive] = React.useState(product?.active ?? true);
  const [terms, setTerms] = React.useState(JSON.stringify(product?.defaultTerms ?? {}, null, 2));
  const termsCheck = parseJsonObject(terms);
  const { run, pending, errors } = useAction(saveProduct, { success: product ? "Product saved" : "Product added", onSuccess: onDone });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void run({
          id: product?.id,
          family,
          name,
          sku,
          description,
          pipelineKeys,
          pricingModel: (pricingModel || null) as Pricing | null,
          status,
          active,
          defaultTermsText: terms,
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{product ? `Edit · ${product.name}` : "New product"}</DialogTitle>
        <DialogDescription>Changes are audit-logged.</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Family" htmlFor={`${id}-family`} error={errors.family}>
            <Input id={`${id}-family`} list={`${id}-families`} value={family} onChange={(e) => setFamily(e.target.value)} required />
            <datalist id={`${id}-families`}>
              {families.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <Field label="Name" htmlFor={`${id}-name`} error={errors.name}>
            <Input id={`${id}-name`} value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="SKU" htmlFor={`${id}-sku`} error={errors.sku}>
            <Input id={`${id}-sku`} value={sku} onChange={(e) => setSku(e.target.value)} />
          </Field>
          <Field label="Pricing model" htmlFor={`${id}-pricing`} error={errors.pricingModel}>
            <NativeSelect id={`${id}-pricing`} value={pricingModel} onChange={(e) => setPricingModel(e.target.value)}>
              <option value="">Not set</option>
              {PRICING_MODELS.map((m) => (
                <option key={m} value={m}>
                  {PRICING_MODEL_LABELS[m]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Status" htmlFor={`${id}-status`} error={errors.status}>
            <NativeSelect id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as ProductStatus)}>
              {PRODUCT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <div className="flex items-end justify-between gap-3 pb-2">
            <label htmlFor={`${id}-active`} className="text-sm text-body">
              Active (offered on new deals)
            </label>
            <Switch id={`${id}-active`} label="Product active" checked={active} onCheckedChange={setActive} />
          </div>
        </div>
        <div className="space-y-1.5">
          <p id={`${id}-pipes`} className="text-xs font-medium text-secondary">
            Pipelines
          </p>
          <ChipMultiSelect labelId={`${id}-pipes`} options={pipelines.map((p) => ({ value: p.key, label: p.key, color: p.color }))} value={pipelineKeys} onChange={setPipelineKeys} />
          {errors.pipelineKeys ? <p className="text-xs text-secondary" role="alert">{errors.pipelineKeys[0]}</p> : null}
        </div>
        <Field label="Description" htmlFor={`${id}-desc`} error={errors.description}>
          <Textarea id={`${id}-desc`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Default terms (JSON)"
          htmlFor={`${id}-terms`}
          error={!termsCheck.ok ? termsCheck.error : errors.defaultTermsText}
          hint='e.g. {"rampMonths": 3, "guaranteeRange": [5000, 20000], "termYears": 3}'
        >
          <Textarea id={`${id}-terms`} rows={5} spellCheck={false} className="font-mono text-xs" value={terms} onChange={(e) => setTerms(e.target.value)} aria-invalid={!termsCheck.ok} />
        </Field>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={pending || !termsCheck.ok}>
          {product ? "Save product" : "Add product"}
        </Button>
      </DialogFooter>
    </form>
  );
}
