import type { SampleSurvey } from "../../import/sample-survey.js";

/**
 * What the sample on screen is, where it comes from and why it is worth a
 * look, so a sample reads as a real job rather than a random scan. Opened
 * from the top bar, beside the scan's name, so it never stands between the
 * user and the analysis.
 */
export function SampleAbout({ sample }: { sample: SampleSurvey }) {
  return (
    <div className="sample-about">
      <p className="sample-about-lead">
        <strong>{sample.name}</strong>
        {` · real drone survey, ${sample.captured}`}
      </p>
      <p>{sample.about}</p>
      <h4>Why it is useful</h4>
      <p>{sample.why}</p>
      <h4>Try</h4>
      <ul>
        {sample.tryThis.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <dl className="stat-list">
        <div>
          <dt>Where</dt>
          <dd>{sample.place}</dd>
        </div>
        <div>
          <dt>Flown with</dt>
          <dd>{sample.platform}</dd>
        </div>
        <div>
          <dt>Patch</dt>
          <dd>{sample.area}</dd>
        </div>
      </dl>
      <p className="note">{sample.prepared}</p>
      <p className="note">
        {`${sample.credit} `}
        <a href={sample.sourceUrl} target="_blank" rel="noreferrer">
          Source
        </a>
        {" · "}
        <a href={sample.licenceUrl} target="_blank" rel="noreferrer">
          {sample.licence}
        </a>
      </p>
    </div>
  );
}

/** Whose data the sample is, in the corner of the scan, as a map credits its tiles. */
export function SampleAttribution({ sample }: { sample: SampleSurvey }) {
  return (
    <p className="ws-attribution">
      {"Data: "}
      <a href={sample.sourceUrl} target="_blank" rel="noreferrer">
        {sample.creditShort}
      </a>
      {" · "}
      <a href={sample.licenceUrl} target="_blank" rel="noreferrer">
        {sample.licence}
      </a>
    </p>
  );
}
