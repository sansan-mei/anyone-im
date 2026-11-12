import { View, Text, TextInput, TouchableOpacity, SafeAreaView, StyleSheet, Alert } from 'react-native'
import { useState } from 'react'
import { router } from 'expo-router'

const API_BASE = 'http://127.0.0.1:4100'

export default function CreateRoom() {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [visibility, setVisibility] = useState<'public' | 'private'>('private')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)

  const handleCreate = async () => {
    if (!name.trim()) {
      Alert.alert('提示', '请输入房间名称')
      return
    }
    
    if (visibility === 'private' && password.length < 6) {
      Alert.alert('提示', '私密房间需要至少 6 位密码')
      return
    }
    
    setLoading(true)
    try {
      const res = await fetch(`${API_BASE}/api/rooms`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          visibility,
          password: visibility === 'private' ? password : undefined
        })
      })
      const data = await res.json()
      
      if ('error' in data) {
        Alert.alert('创建失败', data.error.message)
        return
      }
      
      router.replace('/')
    } catch (e) {
      Alert.alert('错误', '网络连接失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backButtonText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>创建房间</Text>
        <View style={{ width: 40 }} />
      </View>
      
      <View style={styles.form}>
        <TextInput
          style={styles.input}
          placeholder="房间名称"
          value={name}
          onChangeText={setName}
          maxLength={64}
        />
        
        <TextInput
          style={[styles.input, styles.textArea]}
          placeholder="描述（可选）"
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={3}
          maxLength={240}
        />
        
        <View style={styles.visibilityContainer}>
          <Text style={styles.label}>可见性：</Text>
          <View style={styles.visibilityButtons}>
            <TouchableOpacity
              style={[styles.visibilityButton, visibility === 'public' && styles.visibilityButtonActive]}
              onPress={() => setVisibility('public')}
            >
              <Text style={[styles.visibilityButtonText, visibility === 'public' && styles.visibilityButtonTextActive]}>公开</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.visibilityButton, visibility === 'private' && styles.visibilityButtonActive]}
              onPress={() => setVisibility('private')}
            >
              <Text style={[styles.visibilityButtonText, visibility === 'private' && styles.visibilityButtonTextActive]}>私密</Text>
            </TouchableOpacity>
          </View>
        </View>
        
        {visibility === 'private' && (
          <TextInput
            style={styles.input}
            placeholder="房间密码（至少 6 位）"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
          />
        )}
        
        <TouchableOpacity
          style={[styles.button, loading && styles.buttonDisabled]}
          onPress={handleCreate}
          disabled={loading}
        >
          <Text style={styles.buttonText}>{loading ? '创建中...' : '创建房间'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0'
  },
  backButton: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  backButtonText: { fontSize: 24, color: '#1a73e8' },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  form: { padding: 16 },
  input: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#e0e0e0'
  },
  textArea: { height: 80, textAlignVertical: 'top' },
  visibilityContainer: { marginBottom: 16 },
  label: { fontSize: 14, color: '#666', marginBottom: 8 },
  visibilityButtons: { flexDirection: 'row' },
  visibilityButton: {
    flex: 1,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    alignItems: 'center',
    backgroundColor: '#fff'
  },
  visibilityButtonActive: { backgroundColor: '#1a73e8', borderColor: '#1a73e8' },
  visibilityButtonText: { fontSize: 14, color: '#666' },
  visibilityButtonTextActive: { color: '#fff', fontWeight: '600' },
  button: {
    backgroundColor: '#1a73e8',
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' }
})
