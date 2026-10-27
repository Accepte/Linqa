const LOADER_TEXT_SLICES = Array.from({ length: 9 }, (_, index) => index)

export default function LinqaLoader() {
  return (
    <div className="linqa-boot-loader" role="status" aria-label="Loading Linqa">
      <div className="linqa-brand-loader" aria-hidden="true">
        {LOADER_TEXT_SLICES.map(index => (
          <div className="linqa-brand-loader__text" key={index}>
            <span>Linqa</span>
          </div>
        ))}
        <div className="linqa-brand-loader__line" />
      </div>
    </div>
  )
}
