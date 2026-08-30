function AuthScreen({ heading, children }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 360,
          background: 'var(--paper-raised)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '32px',
        }}
      >
        <span className="eyebrow">TVÅ / GRUND</span>
        <h1 style={{ fontSize: '1.5rem', margin: '8px 0 16px' }}>{heading}</h1>
        {children}
      </div>
    </div>
  )
}

export default AuthScreen
