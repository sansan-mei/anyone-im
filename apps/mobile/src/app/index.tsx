import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, SafeAreaView, StyleSheet } from 'react-native'
import { useState, useEffect } from 'react'
import { Link, router } from 'expo-router'
import { io, type Socket } from 'socket.io-client'
import type { ServerToClientEvents, ClientToServerEvents, Message, RoomSummary } from '@anyone-im/contracts'

const API_BASE = 'http://127.0.0.1:4100'

export default function Index() {
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/rooms`, { credentials: 'include' })
        const data = await res.json()
        if ('error' in data) {
          router.replace('/login')
          return
        }
        setRooms(data.data)
        
        const socketInstance = io(API_BASE, {
          transports: ['websocket', 'polling'],
          withCredentials: true,
          reconnectionDelay: 800,
          reconnectionDelayMax: 8000
        })
        
        socketInstance.on('connect', () => console.log('Socket connected'))
        socketInstance.on('message:new', (message: Message) => {
          setRooms(prev => prev.map(r => r.id === message.roomId 
            ? { ...r, lastMessage: message, lastSeq: message.seq, updatedAt: message.createdAt }
            : r
          ).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()))
        })
        
        setSocket(socketInstance)
      } catch (e) {
        setError('加载失败，请重试')
      } finally {
        setLoading(false)
      }
    }
    init()
    
    return () => {
      socket?.disconnect()
    }
  }, [])

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
      </SafeAreaView>
    )
  }

  if (error) {
    return (
      <SafeAreaView style={styles.center}>
        <Text>{error}</Text>
        <TouchableOpacity onPress={() => router.replace('/login')} style={styles.button}>
          <Text style={styles.buttonText}>去登录</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Anyone IM</Text>
        <Link href="/room/create" asChild>
          <TouchableOpacity style={styles.createButton}>
            <Text style={styles.buttonText}>+</Text>
          </TouchableOpacity>
        </Link>
      </View>
      
      <ScrollView style={styles.roomList}>
        {rooms.map(room => (
          <TouchableOpacity
            key={room.id}
            style={styles.roomItem}
            onPress={() => router.push(`/room/${encodeURIComponent(room.id)}`)}
          >
            <View style={styles.roomInfo}>
              <Text style={styles.roomName}>{room.name}</Text>
              {room.lastMessage && (
                <Text style={styles.lastMessage} numberOfLines={1}>
                  {room.lastMessage.sender.displayName}: {room.lastMessage.text || '[图片]'}
                </Text>
              )}
            </View>
            <View style={styles.roomMeta}>
              <Text style={styles.onlineCount}>{room.onlineCount}🟢</Text>
              <Text style={styles.time}>
                {new Date(room.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
      
      <Link href="/login" asChild>
        <TouchableOpacity style={styles.profileButton}>
          <Text style={styles.profileButtonText}>个人中心</Text>
        </TouchableOpacity>
      </Link>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f5f5f5' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0'
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1a73e8' },
  createButton: {
    backgroundColor: '#1a73e8',
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center'
  },
  buttonText: { color: '#fff', fontSize: 20, fontWeight: 'bold' },
  roomList: { flex: 1 },
  roomItem: {
    flexDirection: 'row',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0'
  },
  roomInfo: { flex: 1 },
  roomName: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  lastMessage: { fontSize: 14, color: '#666' },
  roomMeta: { alignItems: 'flex-end', justifyContent: 'space-between' },
  onlineCount: { fontSize: 12, marginBottom: 4 },
  time: { fontSize: 12, color: '#999' },
  profileButton: {
    margin: 16,
    padding: 12,
    backgroundColor: '#1a73e8',
    borderRadius: 8,
    alignItems: 'center'
  },
  profileButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' }
})
