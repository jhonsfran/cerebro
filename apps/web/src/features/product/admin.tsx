import { ConnectorsPanel } from "./connectors";
import { SkillsPanel } from "./skills";

export type AdminView = "connectors" | "skills";

const items: readonly { readonly view: AdminView; readonly label: string }[] = [
  { label: "Connectors", view: "connectors" },
  { label: "Skills", view: "skills" },
];

// Installation settings, shown to people with the installation manage grant.
export const AdminNav = ({
  visible,
  active,
  open,
}: {
  visible: boolean;
  active: AdminView | null;
  open: (view: AdminView) => void;
}) =>
  visible ? (
    <>
      <div className="sidebar-section">
        <p className="eyebrow">Administration</p>
      </div>
      <nav className="agent-list" aria-label="Administration">
        {items.map((item) => (
          <button
            className={`agent-list-item ${active === item.view ? "selected" : ""}`}
            key={item.view}
            type="button"
            onClick={() => open(item.view)}
          >
            <span className="agent-avatar">⚙</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </>
  ) : null;

export const AdminPanel = ({ view }: { view: AdminView }) =>
  view === "connectors" ? <ConnectorsPanel /> : <SkillsPanel />;
