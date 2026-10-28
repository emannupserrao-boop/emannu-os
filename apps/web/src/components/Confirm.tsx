export function Confirm(props: { message: string; onYes(): void; onNo(): void }) {
  return (
    <div className="drawer-backdrop center" onClick={props.onNo}>
      <div className="confirm" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p>{props.message}</p>
        <div className="confirm-actions">
          <button className="btn" onClick={props.onNo} autoFocus>
            Voltar
          </button>
          <button className="btn btn-primary" onClick={props.onYes}>
            Confirmar
          </button>
        </div>
      </div>
    </div>
  );
}
