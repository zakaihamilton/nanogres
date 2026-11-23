import { ActivityList, Panel, ScreenHeading } from "./primitives";
import styles from "./primitives.module.css";

export function ActivityScreen() {
  return (
    <div className={styles.screen}>
      <ScreenHeading
        description="A server-side record of database, role, and backup operations."
        eyebrow="AUDIT TRAIL"
        title="Activity"
      />
      <Panel detail="Newest operations first" title="Recent events">
        <ActivityList />
      </Panel>
    </div>
  );
}
