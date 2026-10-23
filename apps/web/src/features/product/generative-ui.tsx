import { uiCatalog } from "@cerebro/generative-ui/catalog";
import type { UiPresentation } from "@cerebro/generative-ui/presentation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@cerebro/ui/components/card";
import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react";

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
          <h3>{props.title}</h3>
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
      <section
        className="generated-table-scroll"
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users must be able to scroll overflowing tables.
        tabIndex={0}
        aria-label={props.caption}
      >
        <table>
          <caption>{props.caption}</caption>
          <thead>
            <tr>
              {props.columns.map((column, index) => (
                <th key={`${index}:${column}`} scope="col">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, rowIndex) => (
              <tr key={`${rowIndex}:${JSON.stringify(row)}`}>
                {row.map((cell, columnIndex) => (
                  <td key={`${columnIndex}:${cell}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
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
    <details className="generated-summary">
      <summary>Text summary</summary>
      <p>{presentation.fallbackText}</p>
    </details>
  </section>
);
