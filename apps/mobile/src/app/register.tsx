import { View, Text, TextInput, TouchableOpacity, SafeAreaView, StyleSheet, Alert, ScrollView } from 'react-native'
import { useState } from 'react'
import { router } from 'expo-router'

const API_BASE = 'http://127.0.0.1:4100'

export default function Register() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [loading, setLoading] = useState(false)

  const handleRegister = async () => {
    if (!username || !password || !displayName) {
      Alert.alert('提示', '请填写所有字段')
      return
    }
    
    if (password.length < 12) {
      Alert.alert('提示', '密码至少需要 12 位')
      return
    }
    
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, displayName })
      })
      const data = await res.json()
      
      if ('error' in data) {
        Alert.alert('注册失败', data.error.message)
        return
      }
      
      Alert.alert('成功', '注册成功，请登录', [{ text: '好的', onPress: () => router.replace('/login') }])
    } catch (e) {
      Alert.alert('错误', '网络连接失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>注册账号</Text>
        
        <TextInput
          style={styles.input}
          placeholder="用户名（3-32 位小写字母、数字、下划线）"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
        />
        
        <TextInput
          style={styles.input}
          placeholder="显示名称（1-32 位）"
          value={displayName}
          onChangeText={setDisplayName}
        />
        
        <TextInput
          style={styles.input}
          placeholder="密码（至少 12 位）"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
        />
        
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleRegister}
          disabled={loading}
        >
          <Text style={styles.buttonText}>{loading ? '注册中...' : '注册'}</Text>
        </TouchableOpacity>
        
        <TouchableOpacity onPress={() => router.back()} style={styles.link}>
          <Text style={styles.linkText}>返回登录</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  scroll: { padding: 24 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 32, textAlign: 'center', color: '#1a73e8' },
  input: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  button: {
    backgroundColor: '#1a73e8',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  link: { marginTop: 24, alignItems: 'center' },
  linkText: { color: '#1a73e8', fontSize: 14 }
})
