import { uiCatalog } from "@cerebro/generative-ui/catalog";
import type { UiPresentation } from "@cerebro/generative-ui/presentation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@cerebro/ui/components/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@cerebro/ui/components/table";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";

import { Disclosure } from "./disclosure";

const { registry } = defineRegistry(uiCatalog, {
  components: {
    Stack: ({ props, children }) => (
      <div className={`generated-stack generated-stack-${props.direction}`}>
        {children}
      </div>
    ),
    Card: ({ props, children }) => (
      <Card className="generated-card" size="sm">
        <CardHeader>
          <CardTitle>
            <h3>{props.title}</h3>
          </CardTitle>
          {props.description ? (
            <CardDescription>{props.description}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    ),
    Text: ({ props }) => (
      <p className={props.tone === "muted" ? "generated-muted" : undefined}>
        {props.text}
      </p>
    ),
    Metric: ({ props }) => (
      <div className="generated-metric">
        <p>{props.label}</p>
        <strong>{props.value}</strong>
        {props.detail ? (
          <p className="generated-muted">{props.detail}</p>
        ) : null}
      </div>
    ),
    KeyValue: ({ props }) => (
      <dl className="generated-key-value">
        <dt>{props.label}</dt>
        <dd>{props.value}</dd>
      </dl>
    ),
    Table: ({ props }) => (
      <Table className="tabular-nums">
        <TableCaption className="text-foreground mt-0 mb-2 caption-top text-left font-medium">
          {props.caption}
        </TableCaption>
        <TableHeader>
          <TableRow>
            {props.columns.map((column, index) => (
              <TableHead key={`${index}:${column}`} scope="col">
                {column}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.rows.map((row, rowIndex) => (
            <TableRow key={`${rowIndex}:${JSON.stringify(row)}`}>
              {row.map((cell, columnIndex) => (
                <TableCell
                  className="max-w-72 whitespace-normal"
                  key={`${columnIndex}:${cell}`}
                >
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    ),
  },
});

export const GenerativeUi = ({
  presentation,
}: {
  readonly presentation: UiPresentation;
}) => (
  <section className="generated-ui" aria-label="Agent report">
    <JSONUIProvider registry={registry}>
      <Renderer registry={registry} spec={presentation.spec} />
    </JSONUIProvider>
    <Disclosure summary="Text summary" className="generated-summary mt-3">
      <p>{presentation.fallbackText}</p>
    </Disclosure>
  </section>
);
