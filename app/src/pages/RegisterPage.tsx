import { useState } from 'react';
import { Link } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import { api } from '../api';

export function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function handleRegister() {
    setLoading(true);
    setError(null);
    try {
      await api('/api/register/begin', {
        method: 'POST',
        body: JSON.stringify({ name, email }),
      });

      const { options, challengeId } = await api<{
        options: Parameters<typeof startRegistration>[0]['optionsJSON'];
        challengeId: string;
      }>('/api/register/passkey/options', { method: 'POST' });

      const registrationResponse = await startRegistration({ optionsJSON: options });

      const result = await api<{ message: string }>('/api/register/passkey/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId, registrationResponse }),
      });

      setDone(result.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="container">
        <div className="card">
          <h1>注册已提交</h1>
          <p className="success">{done}</p>
          <Link to="/login" className="btn">
            返回登录
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="card">
        <h1>注册</h1>
        <p className="sub">注册 Passkey 后需等待管理员审批。</p>
        <label htmlFor="name">名字</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="email">邮箱</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button
          disabled={!name.trim() || !email.trim() || loading}
          onClick={handleRegister}
        >
          {loading ? '处理中…' : '注册 Passkey'}
        </button>
        <p style={{ marginTop: '1rem' }}>
          已有账号？ <Link to="/login">登录</Link>
        </p>
      </div>
    </div>
  );
}
